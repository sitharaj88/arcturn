import type { Metadata } from "next";
import Link from "next/link";
import { Code } from "@/components/marketing";
import { CTASection } from "@/components/site/CTASection";
import { Card } from "@/components/ui/Card";
import { Container } from "@/components/ui/Container";
import { PageHeader } from "@/components/ui/PageHeader";
import { Reveal } from "@/components/ui/Reveal";
import { type TerminalLine, TerminalMock } from "@/components/ui/TerminalMock";
import { TerminalPlayer } from "@/components/ui/TerminalPlayer";

const LEDE =
  "Differential rendering, a composed frame, and a prompt that stays responsive while the model " +
  "streams.";

export const metadata: Metadata = {
  title: "The terminal",
  description: LEDE,
  openGraph: {
    type: "website",
    siteName: "Arcturn",
    title: "The terminal — Arcturn",
    description: LEDE,
    url: "/terminal",
  },
};

interface Moment {
  id: string;
  title: string;
  body: React.ReactNode;
  terminalTitle: string;
  description: string;
  lines: TerminalLine[];
}

/**
 * Every line below is transcribed from `content/docs/*.md`. The rule for this
 * page (DESIGN.md §3.9): illustrate real output, never invent it.
 */
const MOMENTS: Moment[] = [
  {
    id: "prompt",
    title: "The prompt",
    body: (
      <>
        <p>
          <Code>arcturn</Code> starts an interactive session rooted at your current working
          directory. Every tool call — reading a file, editing one, running a shell command — is
          scoped to that directory.
        </p>
        <p>
          The header names the model in effect and the root the session is bound to, so the two
          facts that decide what a turn can do are never more than a glance away.
        </p>
      </>
    ),
    terminalTitle: "arcturn — ~/projects/api",
    description:
      "An arcturn session header naming the model and working directory, with a typed prompt asking for input validation on the signup handler.",
    lines: [
      { text: "✦ arcturn · claude-sonnet-4-5 · ~/projects/api", tone: "accent" },
      { text: "› add input validation to the /signup handler", tone: "prompt", cursor: true },
    ],
  },
  {
    id: "tool-call",
    title: "A tool call",
    body: (
      <>
        <p>
          The TUI renders each tool call as it happens. The same activity is available as data:{" "}
          <Code>--output-format json</Code> emits the agent’s full event stream as newline-delimited
          JSON, one <Code>AgentEvent</Code> per line — exactly the shape the SDK gives you.
        </p>
        <p>Diagnostics always go to stderr, so piping stdout stays clean data either way.</p>
      </>
    ),
    terminalTitle: "arcturn --output-format json",
    description:
      "A non-interactive arcturn run printing its event stream as newline-delimited JSON: a turn start, a grep tool call start and end, and a completed run end.",
    lines: [
      {
        text: '$ arcturn -p "list every TODO comment in src/" --output-format json',
        tone: "prompt",
      },
      { text: "" },
      { text: '{"type":"turnStart","turn":1}', tone: "muted" },
      {
        text: '{"type":"toolCallStart","toolCallId":"tc_1","toolName":"grep","input":{"pattern":"TODO"}}',
        tone: "default",
      },
      {
        text: '{"type":"toolCallEnd","toolCallId":"tc_1","result":{"content":[{"type":"text","text":"…"}]}}',
        tone: "default",
      },
      { text: '{"type":"runEnd","reason":"completed"}', tone: "good", cursor: true },
    ],
  },
  {
    id: "permission",
    title: "A permission ask",
    body: (
      <>
        <p>
          The first time Arcturn needs to write a file or run a shell command, it asks — unless a
          rule already settles it. Allow once, deny, or persist a rule from the prompt itself:{" "}
          <Code>always allow src/**.ts</Code> writes that rule to project scope.
        </p>
        <p>
          In non-interactive mode there is no user to answer, so a check that would have asked is
          denied automatically, with a note on stderr naming the flag that would have allowed it.
        </p>
      </>
    ),
    terminalTitle: "arcturn — permission",
    description:
      "A permission prompt: editing src/routes/signup.ts requires approval, offering allow, deny, or always allow for src/**.ts.",
    lines: [
      { text: "⚠ Permission required — edit src/routes/signup.ts", tone: "warn" },
      { text: "  a  allow    d  deny    A  always allow src/**.ts", tone: "muted" },
      { text: "" },
      { text: "  ▸ ", tone: "muted", cursor: true },
    ],
  },
  {
    id: "diff",
    title: "A diff",
    body: (
      <>
        <p>
          Under <Code>--dry-run</Code>, file mutations land in a shadow copy of the workspace
          instead of your tree. <Code>/diff</Code> prints one aggregate unified diff across every
          pending change, paths relative to the workspace root, three lines of context per hunk.
        </p>
        <p>
          <Code>/apply</Code> writes them back through a temp-file-plus-rename so an interrupted
          apply can never leave a half-written file; <Code>/discard</Code> deletes the shadow tree.
        </p>
      </>
    ),
    terminalTitle: "arcturn — dry run",
    description:
      "The /diff command printing a unified diff of one pending change to src/app.ts inside the dry-run shadow tree.",
    lines: [
      { text: "> /diff", tone: "prompt" },
      { text: "--- a/src/app.ts", tone: "muted" },
      { text: "+++ b/src/app.ts", tone: "muted" },
      { text: "@@ -12,3 +12,4 @@", tone: "accent" },
      { text: "  export function start() {", tone: "default" },
      { text: '-  console.log("boot");', tone: "bad" },
      { text: '+  console.log("booting");', tone: "good" },
      { text: "+  return true;", tone: "good" },
      { text: "  }", tone: "default", cursor: true },
    ],
  },
  {
    id: "delegation",
    title: "A delegated agent",
    body: (
      <>
        <p>
          <Code>/bg &lt;task&gt;</Code> starts a full child agent running your task as its sole
          prompt, off the foreground thread, and returns immediately. <Code>/bg logs</Code>,{" "}
          <Code>/bg cancel</Code> and <Code>/bg adopt</Code> check back on it later — adopting pulls
          its final result into the live conversation.
        </p>
        <p>
          A background agent runs in <Code>default</Code> permission mode, never <Code>yolo</Code>:
          there is nowhere to send a prompt for an unattended agent, so it fails closed by
          construction. It cannot spawn further agents.
        </p>
      </>
    ),
    terminalTitle: "arcturn — background agent",
    description:
      "The /bg command starting a background agent to fix a flaky retry test, which reports its agent id and session id and returns immediately.",
    lines: [
      { text: "/bg fix the flaky retry test and open a summary of what was wrong", tone: "prompt" },
      {
        text: "Started background agent bg-a1b2c3d4 (session <sessionId>).",
        tone: "good",
        cursor: true,
      },
    ],
  },
  {
    id: "rewind",
    title: "/rewind",
    body: (
      <>
        <p>
          <Code>/rewind</Code> with no argument opens a picker: one row per turn, newest first, each
          labelled with the prompt that began it and how many files changed after that point.
        </p>
        <p>
          Choosing one restores the files that changed after that turn and forks the conversation
          rather than deleting it. The turns you rewound past stay reachable by resuming the session
          at their own leaf.
        </p>
      </>
    ),
    terminalTitle: "arcturn — rewind",
    description:
      "The /rewind picker listing turns newest first with how many files changed after each, then the result line reporting restored and deleted files.",
    lines: [
      { text: "› /rewind", tone: "prompt" },
      { text: "" },
      { text: "  Rewind to the start of…", tone: "muted" },
      {
        text: "  rate-limit the login route     3 files changed after this point",
        tone: "default",
      },
      { text: "  add a test for the limiter     1 file changed after this point", tone: "default" },
      { text: "" },
      { text: "  Restored 3 files, deleted 1.", tone: "good" },
      {
        text: "  Conversation forked; earlier branch still resumable.",
        tone: "accent",
        cursor: true,
      },
    ],
  },
];

const SLASH_COMMANDS = [
  {
    command: "/model",
    body: "Switch model mid-session, or refresh the live catalog.",
    href: "/docs/providers",
  },
  {
    command: "/permissions",
    body: "Print the current rules and pick a permission mode.",
    href: "/docs/permissions",
  },
  {
    command: "/diff · /apply · /discard",
    body: "Review, land or drop the dry-run shadow tree.",
    href: "/docs/dry-run",
  },
  {
    command: "/rewind",
    body: "Restore files from a turn and fork the conversation.",
    href: "/docs/checkpoints",
  },
  {
    command: "/cost",
    body: "Current spend, the ceiling, and a forecast before you commit.",
    href: "/docs/audit-cost",
  },
  {
    command: "/bg · /team",
    body: "A durable background task, or a coordinated set of agents.",
    href: "/docs/teams",
  },
  {
    command: "/workflow",
    body: "Run a file-defined, deterministic multi-step pipeline.",
    href: "/docs/workflows",
  },
];

export default function TerminalPage() {
  return (
    <>
      <Container className="pb-4 pt-16 md:pt-20">
        <PageHeader eyebrow="Project" title="The terminal" lede={LEDE} />
      </Container>

      {/*
        The hero plays rather than poses: it stops at the permission gate and
        waits for the reader to answer. §2.3.4 gives `--shadow-glow` to the hero
        terminal, so it lands here and on nothing else below — the moments are
        stills, and a page of glowing stills would say nothing about which one
        is the subject.
      */}
      <Container size="wide" className="pb-4">
        <TerminalPlayer size="lg" glow title="arcturn — ~/projects/api" />
      </Container>

      <Container className="flex flex-col gap-20 py-16 md:gap-28 md:py-20">
        {MOMENTS.map((moment, index) => (
          <Reveal key={moment.id}>
            <section id={moment.id} className="grid items-center gap-8 lg:grid-cols-2 lg:gap-14">
              <div className={index % 2 === 1 ? "min-w-0 lg:order-2" : "min-w-0"}>
                <h2 className="text-h3 text-text">{moment.title}</h2>
                <div className="mt-4 flex flex-col gap-4 text-body-sm text-muted">
                  {moment.body}
                </div>
              </div>
              <div className={index % 2 === 1 ? "min-w-0 lg:order-1" : "min-w-0"}>
                <TerminalMock
                  title={moment.terminalTitle}
                  lines={moment.lines}
                  description={moment.description}
                />
              </div>
            </section>
          </Reveal>
        ))}

        <Reveal>
          <Card>
            <h2 className="text-h3 text-text">Slash commands</h2>
            <p className="mt-2 max-w-[62ch] text-body-sm text-muted">
              The session-level controls, each with a page of documentation behind it.
            </p>
            <ul className="mt-6 grid list-none gap-x-8 gap-y-4 sm:grid-cols-2">
              {SLASH_COMMANDS.map((item) => (
                <li key={item.command}>
                  <Link
                    href={item.href}
                    className="inline-flex min-h-11 items-center font-mono text-body-sm font-medium text-accent hover:text-accent-hover sm:min-h-0"
                  >
                    {item.command}
                  </Link>
                  <p className="text-body-sm text-muted">{item.body}</p>
                </li>
              ))}
            </ul>
          </Card>
        </Reveal>
      </Container>

      <CTASection />
    </>
  );
}
