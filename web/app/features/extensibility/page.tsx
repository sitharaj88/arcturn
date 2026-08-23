import type { Metadata } from "next";
import { Code, ProseSection } from "@/components/marketing";
import { CTASection } from "@/components/site/CTASection";
import { CodeBlock } from "@/components/ui/CodeBlock";
import { Container } from "@/components/ui/Container";
import { DocLinks } from "@/components/ui/DocLinks";
import { PageHeader } from "@/components/ui/PageHeader";
import { Reveal } from "@/components/ui/Reveal";

/**
 * Shown to the reader as literal config syntax, so it must stay a plain
 * string.
 */
// biome-ignore lint/suspicious/noTemplateCurlyInString: prose, not code — the reader is meant to see the literal placeholder syntax.
const ENV_PLACEHOLDER = "${ENV_VAR}";

const LEDE =
  "Most of what you’ll want to add is a markdown file or a config entry. The rest is a " +
  "TypeScript interface.";

export const metadata: Metadata = {
  title: "Extensibility",
  description: LEDE,
  openGraph: {
    type: "website",
    siteName: "Arcturn",
    title: "Extensibility — Arcturn",
    description: LEDE,
    url: "/features/extensibility",
  },
};

const MCP_CONFIG = `{
  "servers": {
    "playwright": {
      "type": "stdio",
      "command": "npx",
      "args": ["@playwright/mcp@latest"]
    },
    "linear": {
      "type": "http",
      "url": "https://mcp.linear.app/sse",
      "headers": { "Authorization": "Bearer \${LINEAR_TOKEN}" }
    }
  }
}`;

const SKILL_FILE = `---
name: changelog
description: Draft a changelog entry for the current diff
---
Summarize the staged git diff as a changelog entry in Keep a Changelog style.
Focus on: $ARGUMENTS`;

const HOOKS_CONFIG = `{
  "hooks": {
    "preToolUse": [
      { "command": "./.arcturn/hooks/guard-bash.sh", "matcher": "bash" }
    ],
    "postToolUse": [
      { "command": "./.arcturn/hooks/log-tool-use.sh", "timeoutMs": 5000 }
    ],
    "sessionStart": [
      { "command": "echo session started >> .arcturn/session.log" }
    ]
  }
}`;

const AGENT_DEF = `---
name: doc-reviewer
description: Reviews documentation for accuracy against source code
tools: read, grep, glob
model: anthropic/claude-haiku-4-5
---
You are a documentation accuracy reviewer. For every claim in the document, find the
corresponding source location and confirm it. Flag anything unverifiable or stale.`;

const WORKFLOW_FILE = `---
name: ship-fix
description: Reproduce, patch and review one bug report
continueOnError: false
---
1. [anthropic/claude-haiku-4-5] Reproduce this bug and quote the failing output: {{input}}
2. Given the repro below, do both halves:
   - Write the minimal patch. Repro: {{prev}}
   - Write a regression test that fails before the patch. Repro: {{prev}}
3. Review the patch and the test for correctness. Work so far: {{prev}}`;

const TOOL_INTERFACE = `interface Tool {
  definition: ToolDefinition;
  execute(input: Record<string, unknown>, ctx: ToolExecutionContext): Promise<ToolResult>;
}

interface ToolExecutionContext {
  cwd: string;
  /** Aborts when the user interrupts the run. */
  signal: AbortSignal;
  /** Ask the permission engine (may prompt the user) before a sensitive action. */
  requestPermission: PermissionRequester;
  /** Report incremental progress; safe to call many times. */
  onUpdate: (update: ToolUpdate) => void;
  sessionId: string;
  toolCallId: string;
}`;

export default function ExtensibilityPage() {
  return (
    <>
      <Container className="pb-4 pt-16 md:pt-20">
        <PageHeader eyebrow="Capabilities" title="Extensibility" lede={LEDE} />
      </Container>

      <Container className="flex flex-col gap-20 py-16 md:gap-24 md:py-20">
        <Reveal>
          <ProseSection
            id="mcp"
            title="MCP, built in"
            media={<CodeBlock code={MCP_CONFIG} language="json" filename=".arcturn/mcp.json" />}
          >
            <p>
              <Code>@arcturn/mcp</Code> is a Model Context Protocol client that connects to
              configured servers and bridges their tools into ordinary Arcturn tools, exposing their
              resources and prompts through the same manager. Two transports: a <Code>stdio</Code>{" "}
              process, or streamable HTTP with an automatic fall back to SSE for servers that only
              speak the older transport.
            </p>
            <p>
              A malformed entry throws an error naming the exact server and file rather than failing
              the load silently, and an unset <Code>{ENV_PLACEHOLDER}</Code> reference is a hard
              error — a silently empty <Code>Authorization</Code> header is a worse failure mode
              than refusing to start. <Code>arcturn mcp add</Code> manages the same files, so you
              never have to edit the JSON by hand.
            </p>
          </ProseSection>
        </Reveal>

        <Reveal>
          <ProseSection
            id="skills"
            title="Markdown skills"
            media={
              <CodeBlock
                code={SKILL_FILE}
                language="markdown"
                filename=".arcturn/skills/changelog.md"
              />
            }
          >
            <p>
              Drop a file in <Code>~/.arcturn/skills</Code> or <Code>.arcturn/skills</Code> and it
              is a slash command. Frontmatter is optional; the body is the prompt template, with{" "}
              <Code>$ARGUMENTS</Code>, <Code>$1</Code>–<Code>$9</Code>, <Code>$CWD</Code> and{" "}
              <Code>$SKILL_DIR</Code> expanded when the command runs. No build step and no restart —
              the loader re-reads the roots each time skills are discovered.
            </p>
            <p>
              The same library is exposed to the model itself as one ordinary tool, so it can reach
              for a skill mid-task without anyone typing a command. A skill can never shadow a
              built-in command: the built-ins win a name collision and the skill is dropped with a
              warning.
            </p>
          </ProseSection>
        </Reveal>

        <Reveal>
          <ProseSection
            id="hooks"
            title="Hooks at the boundaries"
            media={
              <CodeBlock code={HOOKS_CONFIG} language="json" filename=".arcturn/config.json" />
            }
          >
            <p>
              Hooks are shell commands declared per lifecycle point — <Code>preToolUse</Code>,{" "}
              <Code>postToolUse</Code>, <Code>sessionStart</Code>, <Code>runEnd</Code> — with an
              optional <Code>matcher</Code> restricting which tool they fire for and a{" "}
              <Code>timeoutMs</Code> overriding the ten-second default.
            </p>
            <p>
              The event payload arrives on the hook’s stdin as a single JSON object, so a hook
              decides on the actual arguments rather than a tool name. Only <Code>preToolUse</Code>{" "}
              hooks can block anything, and only the call they ran for.
            </p>
          </ProseSection>
        </Reveal>

        <Reveal>
          <ProseSection
            id="sub-agents"
            title="Sub-agents, plan mode and todos"
            media={
              <CodeBlock
                code={AGENT_DEF}
                language="markdown"
                filename=".arcturn/agents/doc-reviewer.md"
              />
            }
          >
            <p>
              The <Code>subagent</Code> tool delegates a self-contained piece of work to a scoped
              child agent with its own context window, tools and model. The child’s entire event
              stream re-publishes on the parent as <Code>subagentEvent</Code>, so a UI can render
              nested activity without knowing anything about what a sub-agent is, and aborting the
              parent cascades to the child.
            </p>
            <p>
              Named specializations are discovered from markdown, the same way skills are. The{" "}
              <Code>plan</Code> and <Code>todo</Code> tools carry the structured state beside them:
              plan mode is enforced by the permission engine, and the only way out is presenting a
              plan for approval.
            </p>
          </ProseSection>
        </Reveal>

        <Reveal>
          <ProseSection id="teams" title="Agent teams and background agents">
            <p>
              Three ways to spend a second agent, for three different problems. The{" "}
              <Code>subagent</Code> tool is one-shot and synchronous — the parent asks and waits.{" "}
              <Code>/bg</Code> is fire-and-forget and durable: a whole task runs off the foreground
              thread, and <Code>/bg logs</Code>, <Code>/bg cancel</Code> and <Code>/bg adopt</Code>{" "}
              check back on it later.
            </p>
            <p>
              <Code>/team</Code> is orchestration: one goal decomposed into subtasks with provably
              disjoint file scopes, one agent per subtask in its own throwaway git worktree, each
              member’s work captured as a patch file on disk. <Code>/team merge</Code> replays those
              patches with <Code>git apply</Code>, checking each first and stopping at the first
              refusal rather than writing conflict markers into your tree.
            </p>
          </ProseSection>
        </Reveal>

        <Reveal>
          <ProseSection
            id="workflows"
            title="Workflows"
            media={
              <CodeBlock
                code={WORKFLOW_FILE}
                language="markdown"
                filename=".arcturn/workflows/ship-fix.md"
              />
            }
          >
            <p>
              A workflow fixes the control flow in a file and lets the model fill in only the
              content of each step. Top-level numbered items are stages that run strictly in order;
              indented bullets under one are parallel branches whose outputs join in written order,
              never completion order, so the same file always produces the same pipe.
            </p>
            <p>
              A <Code>[tag]</Code> prefix selects the model for that step, and every tag resolves
              before the first step runs — a workflow whose last step names a dead model must not
              spend two paid steps first. Anything the grammar does not accept is a parse error
              naming the line number.
            </p>
          </ProseSection>
        </Reveal>

        <Reveal>
          <ProseSection
            id="custom-tools"
            title="Custom tools and extensions"
            media={<CodeBlock code={TOOL_INTERFACE} language="ts" />}
          >
            <p>
              A tool is one object: a JSON-Schema definition the model sees, and an{" "}
              <Code>execute</Code> function that does the work. The contract in one sentence —{" "}
              <Code>execute</Code> must resolve with a <Code>ToolResult</Code> for every expected
              outcome, including failure, and reject only for genuine programming errors.
            </p>
            <p>
              Its context carries the abort signal, a <Code>requestPermission</Code> callback into
              the same engine the built-ins use, and an <Code>onUpdate</Code> channel for
              incremental progress. Modules dropped in <Code>.arcturn/extensions</Code> are loaded
              the same way, so an extension is TypeScript on disk rather than a fork.
            </p>
          </ProseSection>
        </Reveal>

        <DocLinks
          links={[
            { href: "/docs/mcp", title: "MCP" },
            { href: "/docs/skills", title: "Markdown skills" },
            { href: "/docs/skill-tool", title: "Model-invoked skills" },
            { href: "/docs/hooks", title: "Lifecycle hooks" },
            { href: "/docs/sub-agents", title: "Sub-agents, plan mode & todos" },
            { href: "/docs/teams", title: "Agent teams & background agents" },
            { href: "/docs/workflows", title: "Workflows" },
            { href: "/docs/sdk-tools", title: "Custom tools" },
          ]}
        />
      </Container>

      <CTASection />
    </>
  );
}
