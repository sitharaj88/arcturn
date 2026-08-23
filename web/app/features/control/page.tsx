import type { Metadata } from "next";
import { Code, ProseSection } from "@/components/marketing";
import { CTASection } from "@/components/site/CTASection";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { Container } from "@/components/ui/Container";
import { DefinitionTable } from "@/components/ui/DefinitionTable";
import { DocLinks } from "@/components/ui/DocLinks";
import { PageHeader } from "@/components/ui/PageHeader";
import { Reveal } from "@/components/ui/Reveal";
import { TerminalMock } from "@/components/ui/TerminalMock";

const LEDE =
  "Every mutating tool call clears a rule before it runs — and when the rules can’t decide, " +
  "the answer is no.";

export const metadata: Metadata = {
  title: "Control",
  description: LEDE,
  openGraph: {
    type: "website",
    siteName: "Arcturn",
    title: "Control — Arcturn",
    description: LEDE,
    url: "/features/control",
  },
};

const RULE_SAMPLE = `{
  "tool": "bash",
  "specifier": "git *",
  "action": "allow",
  "scope": "project"
}`;

const SANDBOX_SAMPLE = `{ "sandbox": "workspace-write" }`;

const MODE_ROWS = [
  {
    term: <Code>default</Code>,
    definition:
      "Read-only tools run freely; everything else is asked about unless a rule already settles it.",
  },
  {
    term: <Code>acceptEdits</Code>,
    definition: (
      <>
        Like default, but <Code>write</Code>, <Code>edit</Code> and <Code>multiedit</Code> are also
        auto-approved.
      </>
    ),
  },
  {
    term: <Code>plan</Code>,
    definition: "Only read-only tools may run; every mutating tool is denied outright.",
  },
  {
    term: <Code>yolo</Code>,
    definition: "Everything is auto-approved — for sandboxes and CI, not your laptop.",
  },
];

export default function ControlPage() {
  return (
    <>
      <Container className="pb-4 pt-16 md:pt-20">
        <PageHeader eyebrow="Capabilities" title="Control" lede={LEDE} />
      </Container>

      <Container className="flex flex-col gap-20 py-16 md:gap-24 md:py-20">
        <Reveal>
          <ProseSection
            id="choke-point"
            title="One choke point"
            media={
              <TerminalMock
                variant="permission"
                description="A permission prompt in an arcturn session: editing src/routes/signup.ts requires approval, with allow, deny, and always-allow for src/**.ts offered."
              />
            }
          >
            <p>
              The runtime’s tool dispatcher checks the permission engine and returns a denial before
              a tool’s <Code>execute</Code> is ever reached. There is no second path into a tool, so
              there is no route around the check.
            </p>
            <p>
              Read-only tools — <Code>read</Code>, <Code>grep</Code>, <Code>glob</Code>,{" "}
              <Code>ls</Code> — pass without a prompt, because asking about every file read would
              make the default mode unusable. <Code>fetch</Code> is deliberately not on that list:
              it reads nothing local but sends data to an arbitrary host, so it is gated like a
              mutating tool. Anything that reaches the ask step with no permission requester
              configured resolves to deny, never to “assume it’s fine.”
            </p>
          </ProseSection>
        </Reveal>

        <Reveal>
          <ProseSection
            id="rules"
            title="Rules, scopes, resolution"
            media={<CodeBlock code={RULE_SAMPLE} language="json" filename=".arcturn/config.json" />}
          >
            <p>
              A rule is four fields: a tool name (or <Code>*</Code>), a specifier matched against
              the call’s subject, an action of allow, deny or ask, and a scope. Specifiers come in
              three forms — a command prefix like <Code>git *</Code>, a glob like{" "}
              <Code>**/*.ts</Code>, or an exact string.
            </p>
            <p>
              Scope precedence is session over project over user, with a specificity tiebreak inside
              a scope and deny winning a tie. One deliberate exception: a more specific deny beats a
              broader permissive rule even from a nearer scope, so a checked-in project config
              cannot escalate its own privileges just by being cloned.
            </p>
            <p>
              Approving a prompt with <em>always allow</em> persists the suggested rule — a{" "}
              <Code>bash</Code> subject is widened to its first word plus <Code>{" *"}</Code>, other
              tools default to their exact subject — into the project config.
            </p>
          </ProseSection>
        </Reveal>

        <Reveal>
          <ProseSection
            id="modes"
            title="Four modes"
            media={<DefinitionTable rows={MODE_ROWS} termHeader="Mode" defHeader="Behaviour" />}
          >
            <p>
              A mode is the posture the engine falls back to when no rule matched. Switch at runtime
              with <Code>/permissions</Code> in the CLI, or{" "}
              <Code>agent.setPermissionMode(mode)</Code> from code.
            </p>
            <p>
              Plan mode is enforcement, not etiquette: its check runs before rules are evaluated, so
              no stored allow rule — however specific, however recently added — can let a mutating
              tool through while it is active.
            </p>
          </ProseSection>
        </Reveal>

        <Reveal>
          <ProseSection id="dry-run" title="Dry run and the shadow tree">
            <p>
              <Code>--dry-run</Code> is plan mode for files. The agent works normally, but every
              file mutation is redirected into a shadow copy of the workspace under{" "}
              <Code>~/.arcturn/overlays/&lt;sessionId&gt;/</Code>. Review one aggregate diff with{" "}
              <Code>/diff</Code>, then <Code>/apply</Code> to land it or <Code>/discard</Code> to
              throw it away.
            </p>
            <p>
              The limit, stated plainly: <Code>--dry-run</Code> deliberately does not wrap{" "}
              <Code>bash</Code>, <Code>grep</Code> or <Code>glob</Code> — they take commands and
              patterns rather than a single path — so a shell command still reads and mutates the
              real tree while dry-run is active.
            </p>
          </ProseSection>
        </Reveal>

        <Reveal>
          <ProseSection
            id="hooks-and-sandbox"
            title="Hooks with veto power, and the OS sandbox"
            media={
              <CodeBlock code={SANDBOX_SAMPLE} language="json" filename=".arcturn/config.json" />
            }
          >
            <p>
              Lifecycle hooks are shell commands declared at <Code>preToolUse</Code>,{" "}
              <Code>postToolUse</Code>, <Code>sessionStart</Code> and <Code>runEnd</Code>. Only a{" "}
              <Code>preToolUse</Code> hook can block anything, and only the call it ran for — the
              lifecycle event arrives as JSON on the hook’s stdin, so the hook can decide on the
              actual arguments rather than a tool name.
            </p>
            <p>
              The sandbox is a separate, opt-in layer, and it governs <Code>bash</Code> rather than
              the edit tools. Set to <Code>workspace-write</Code>, the command is wrapped by an
              OS-level sandbox — <Code>sandbox-exec</Code> on macOS, Bubblewrap on Linux — that
              denies file writes everywhere except the working directory, the OS temp directory and{" "}
              <Code>$HOME/.arcturn</Code>. Reads, network and process spawning are left alone: this
              narrows write access only.
            </p>
          </ProseSection>
        </Reveal>

        <Reveal>
          <ProseSection id="speculation" title="Speculative approval">
            <p>
              A permission prompt stops the agent dead, and every second you take to answer is idle
              time. With speculative approval the agent keeps working while the prompt sits in front
              of you, with every file mutation landing in a shadow overlay keyed to that pending
              request. Approve and the shadow is applied instantly; deny and it is thrown away,
              leaving the workspace bit-for-bit what it was.
            </p>
            <p>
              Only <Code>write</Code> and <Code>edit</Code> are speculatable, because only file
              mutations can be undone by throwing a directory away. Everything else —{" "}
              <Code>bash</Code>, <Code>fetch</Code>, <Code>websearch</Code>, any MCP tool,
              sub-agents — is blocked outright for as long as a speculation is open, and nothing is
              ever applied implicitly: a timeout, a dropped connection or a process exit all
              discard.
            </p>
          </ProseSection>
        </Reveal>

        <DocLinks
          links={[
            { href: "/docs/permissions", title: "Permissions" },
            { href: "/docs/dry-run", title: "Dry run & sandbox" },
            { href: "/docs/hooks", title: "Lifecycle hooks" },
            { href: "/docs/speculation", title: "Speculative approval" },
            { href: "/docs/injection-defense", title: "Injection defense" },
          ]}
        />
      </Container>

      <CTASection />
    </>
  );
}
