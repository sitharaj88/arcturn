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
 * Every line below is transcribed from `content/docs/*.md` and from the CLI's
 * own renderers. The rule for this page (DESIGN.md §3.9): illustrate real
 * output, never invent it — and print no timing, token count or dollar figure
 * that is not in the docs, which is why the status bars here carry the model
 * and the permission mode and stop there.
 *
 * The scripts are written in the terminal's vocabulary rather than as spaced
 * strings: `{ kind: "tool" }` for `● ✎ edit  path`, `{ kind: "result" }` for
 * the `⎿` tree, `{ kind: "permission" }` for the bordered gate. Sources, per
 * shape: `packages/cli/src/display.ts` (`TranscriptFormatter` — the `▌` prompt
 * echo, the `  ⎿ ` result prefix, `ℹ ⚠ ✗` notices), `interactive/dialogs.ts`
 * (`permissionDialog` — the box title, the three answers, the footer),
 * `interactive/app.ts` (the input box, the `✦ arcturn · model · mode` status
 * bar), `packages/types/src/events.ts` (the JSON event stream's real shape).
 *
 * `{ kind: "text" }` rows are deliberate: a unified diff and a raw NDJSON dump
 * are bodies the terminal prints verbatim, with no glyph of their own.
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
      "An arcturn session header naming the model and working directory, the prompt editor holding a typed request for input validation on the signup handler, and the status bar naming the permission mode.",
    lines: [
      { kind: "chrome", model: "claude-sonnet-4-5", cwd: "~/projects/api" },
      { kind: "blank" },
      { kind: "input", value: "add input validation to the /signup handler", cursor: true },
      { kind: "status", model: "claude-sonnet-4-5", mode: "default" },
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
    /*
      The one scene on this page that is not the TUI: `--print` writes raw
      NDJSON to stdout, so there is no chrome, no status bar and no glyph to
      draw — the terminal shows the shell line and the bytes. Event names are
      the real ones (`turnStart`/`turnIndex`, `toolStart`, `toolEnd`) per
      `content/docs/sdk-events.md` and `packages/types/src/events.ts`;
      `getting-started.md` still prints a pre-rename set (`toolCallStart`,
      `"turn":1`) that the runtime has not emitted for some time.
    */
    lines: [
      {
        kind: "text",
        text: '$ arcturn -p "list every TODO comment in src/" --output-format json',
        tone: "prompt",
      },
      { kind: "blank" },
      { kind: "text", text: '{"type":"turnStart","turnIndex":0}', tone: "muted" },
      {
        kind: "text",
        text: '{"type":"toolStart","toolCallId":"tc_1","toolName":"grep","input":{"pattern":"TODO"}}',
      },
      {
        kind: "text",
        text: '{"type":"toolEnd","toolCallId":"tc_1","result":{"role":"toolResult","toolName":"grep","isError":false,"content":[{"type":"text","text":"…"}]}}',
      },
      { kind: "text", text: '{"type":"runEnd","reason":"completed"}', tone: "good" },
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
      "An arcturn session that has read src/routes/signup.ts and then stopped at the permission gate: a bordered dialog asking to edit that file, offering allow once, allow always for edit src/routes/signup.ts in project scope, or deny with a reason.",
    /*
      The gate as `permissionDialog` actually builds it, down to two details
      that look like mistakes until you read the source. The muted line under
      the subject really does restate it: `packages/core/src/loop.ts` composes
      every description as `${tool}: ${subject}`, and the gate the user sees is
      that one — the `edit` tool's own, wordier request is served from the
      per-call decision cache and never reaches a dialog. And the always-row
      offers the *exact subject*: `suggestRule` widens `bash` alone, to its
      first word plus `" *"` (docs/permissions.md: "other tools default to
      their exact subject"). A glob like `src/**.ts` is a rule you write, not
      one the dialog suggests.

      One compression: on the permission path `defaultSubject` is given the
      cwd and resolves the path, so the live dialog names
      `/Users/…/projects/api/src/routes/…` and lets `oneLine` clip the
      always-row at 44 columns. The site keeps the workspace-relative spelling
      every other mock and every line of copy on it uses; the dialog's shape is
      unaffected. The `read` row above it needs no such licence — `display.ts`
      calls `defaultSubject` with no cwd, so a transcript shows the path the
      model actually passed.
    */
    lines: [
      { kind: "user", text: "add input validation to the /signup handler" },
      { kind: "blank" },
      { kind: "tool", name: "read", args: "src/routes/signup.ts" },
      { kind: "result", text: "84 lines" },
      { kind: "blank" },
      {
        kind: "permission",
        tool: "edit",
        subject: "src/routes/signup.ts",
        description: "edit: src/routes/signup.ts",
        rule: "edit src/routes/signup.ts",
        selected: "once",
      },
      { kind: "status", model: "claude-sonnet-4-5", mode: "default" },
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
    /*
      `/diff` prints the overlay's aggregate diff through `ui.print`, which
      writes a blank spacer and then the diff verbatim — so the body is text,
      not tool rows. The `+`/`−` tinting is the one liberty, and it is the
      product's own: `TranscriptFormatter#diff` paints an `edit` result's diff
      with `diffAdded` / `diffRemoved` and leaves context muted.
    */
    lines: [
      { kind: "user", text: "/diff" },
      { kind: "blank" },
      { kind: "text", text: "--- a/src/app.ts", tone: "muted" },
      { kind: "text", text: "+++ b/src/app.ts", tone: "muted" },
      { kind: "text", text: "@@ -12,3 +12,4 @@", tone: "accent" },
      { kind: "text", text: "  export function start() {", tone: "muted" },
      { kind: "text", text: '-  console.log("boot");', tone: "bad" },
      { kind: "text", text: '+  console.log("booting");', tone: "good" },
      { kind: "text", text: "+  return true;", tone: "good" },
      { kind: "text", text: "  }", tone: "muted" },
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
      "The /bg command starting a background agent to fix a flaky retry test: an informational notice reports the agent id and session id, and the prompt is free again immediately.",
    /*
      `/bg` reports through `ui.notice("info", …)`, which the formatter draws
      as `ℹ` in the info tone — not a success tick: nothing has succeeded yet,
      an agent has merely been started. The input box below it is the point of
      the moment: the call returned, and the session took no lock.
    */
    lines: [
      { kind: "user", text: "/bg fix the flaky retry test and open a summary of what was wrong" },
      { kind: "blank" },
      {
        kind: "notice",
        level: "info",
        text: "Started background agent bg-a1b2c3d4 (session 019c4a2f).",
      },
      { kind: "blank" },
      { kind: "input" },
      { kind: "status", model: "claude-sonnet-4-5", mode: "default" },
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
      "A /rewind in an arcturn session: two informational notices report that three files were restored and one deleted, and that the conversation forked back to that turn, with the prompt ready underneath.",
    /*
      What the rewind leaves behind. The picker is a `selectDialog` overlay —
      a rounded box with its title on the border, `❯` on the highlighted row
      and the `↑↓ select · enter confirm · esc cancel` footer — and it is off
      the screen the instant a turn is chosen. These two lines are what
      `rewindTo` writes into scrollback, word for word from `commands.ts` and
      `docs/checkpoints.md`. Drawing the picker as bare indented rows would be
      the old hand-spaced fake wearing a new glyph, so it waits for a boxed
      select-dialog line kind rather than being approximated here.
    */
    lines: [
      { kind: "user", text: "/rewind" },
      { kind: "blank" },
      { kind: "notice", level: "info", text: "Restored 3 files, deleted 1." },
      { kind: "notice", level: "info", text: "Conversation forked back to that turn." },
      { kind: "blank" },
      { kind: "input" },
      { kind: "status", model: "claude-sonnet-4-5", mode: "default" },
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
