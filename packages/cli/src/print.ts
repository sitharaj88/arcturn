/**
 * Non-interactive mode (`arcturn -p "…"`).
 *
 * The run is driven to completion with no UI at all: stdout carries either the
 * final assistant message (`--output-format text`) or one JSON object per agent
 * event (`--output-format json`). Diagnostics go to stderr so piping stdout
 * always yields clean data.
 *
 * Permission prompts cannot be answered without a user, so any check that
 * reaches the requester is denied with an explanation the model can act on, and
 * a notice is written to stderr telling the human which flag would have allowed
 * it.
 */

import { text as textBlock } from "@arcturn/core";
import type {
  AgentEvent,
  PermissionDecision,
  PermissionRequest,
  UserContent,
} from "@arcturn/types";
import type { OutputFormat } from "./args.js";
import {
  type CommandRegistry,
  type CommandUi,
  createCommandRegistry,
  parseCommandLine,
} from "./commands.js";
import { expandMentions } from "./mentions.js";
import type { ArcturnRuntime } from "./runtime.js";
import { isWorkflowHumanStop } from "./workflow.js";

/** Options for {@link runPrint}. */
export interface RunPrintOptions {
  /** Assembled runtime; its permission requester is replaced by this function. */
  runtime: ArcturnRuntime;
  /** The prompt to run; content blocks allow attached images. */
  prompt: string | UserContent[];
  /** Output encoding (default `"text"`). */
  outputFormat?: OutputFormat;
  /** stdout sink. Defaults to `process.stdout.write`. */
  stdout?: (chunk: string) => void;
  /** stderr sink. Defaults to `process.stderr.write`. */
  stderr?: (chunk: string) => void;
  /**
   * The slash-command registry a leading-`/` prompt dispatches through.
   * Defaults to the same registry the interactive app builds, extensions
   * included; injectable so a test can script a command.
   */
  commands?: CommandRegistry;
}

/** Result of a `--print` run. */
export interface PrintResult {
  /**
   * Process exit code. For a prompt: `0` on success, `1` on error or abort.
   * For a slash command: `0` when it ran clean, `1` when it reported an
   * error, `2` when no such command exists, and `3` when a workflow stopped
   * for a human — a budget checkpoint, an `ORG-ASK`, or a parked step — so a
   * CI job can tell "finished" from "waiting for you" by the code alone.
   */
  exitCode: number;
  /** The final assistant text, also written to stdout in text mode. */
  text: string;
  /** Why the run stopped. */
  reason: "completed" | "aborted" | "error";
  /** Populated when `reason` is `"error"`. */
  errorMessage?: string;
}

/** The exit code a slash command run under `--print` ends with. */
export const PRINT_EXIT = {
  ok: 0,
  error: 1,
  unknownCommand: 2,
  needsHuman: 3,
} as const;

/**
 * Run one prompt to completion without a UI.
 *
 * @param options - Runtime, prompt and output encoding.
 * @returns The exit code, final text and stop reason.
 */
export async function runPrint(options: RunPrintOptions): Promise<PrintResult> {
  const { runtime, prompt } = options;
  const format = options.outputFormat ?? "text";
  const out = options.stdout ?? ((chunk: string) => void process.stdout.write(chunk));
  const err = options.stderr ?? ((chunk: string) => void process.stderr.write(chunk));

  const denials = new Set<string>();
  runtime.setPermissionRequester(
    async (request: Omit<PermissionRequest, "id">): Promise<PermissionDecision> => {
      const key = `${request.toolName}:${request.subject}`;
      if (!denials.has(key)) {
        denials.add(key);
        err(
          `arcturn: denied ${request.toolName}${request.subject ? ` (${request.subject})` : ""} — ` +
            "non-interactive mode cannot ask. Re-run with --permission-mode acceptEdits or " +
            "yolo, or add a permission rule to .arcturn/config.json.\n",
        );
      }
      return {
        requestId: "",
        behavior: "deny",
        message:
          `Permission for "${request.toolName}" was denied: this is a non-interactive run and ` +
          "the user cannot be asked. Continue without it or explain what is needed.",
      };
    },
  );

  // A leading slash is a command, exactly as it is in the interactive app —
  // `arcturn -p "/workflow rag-setup …"` runs the pipeline, it does not ask
  // the model to. Dispatched after the permission requester above is in
  // place, so a workflow's sub-agents meet the same non-interactive denial a
  // plain prompt's tools do. Content-block prompts (attached images) are
  // never commands.
  // Well-formed only: "/etc/hosts is wrong, fix it" is a prompt about a path,
  // not a command, and must still reach the model exactly as it did before.
  //
  // One command shape is deliberately NOT dispatched: a markdown skill.
  // A skill command has no output of its own — its whole body is a prompt
  // for the main agent (see `skillCommand` in runtime.ts) — so routing it
  // through the command path would run the agent and print nothing, because
  // the headless `ui` below only ever sees `print`/`notice` calls. Expanding
  // it here instead makes `arcturn -p "/my-skill args"` behave exactly like
  // `arcturn -p "<the skill's prompt>"`: streamed events under `--json`, the
  // final assistant text under `--text`, exit 1 when the run errors.
  let skillPrompt: string | undefined;
  if (typeof prompt === "string" && parseCommandLine(prompt.trim())?.wellFormed === true) {
    const registry =
      options.commands ??
      createCommandRegistry(runtime.extensions.commands, (message) => err(`arcturn: ${message}\n`));
    skillPrompt = skillPromptFor(prompt.trim(), runtime, registry);
    if (skillPrompt === undefined) {
      return runPrintCommand(prompt.trim(), options, format, out, err, registry);
    }
  }

  // Held in an object rather than `let` bindings: assignments happen inside a
  // callback, which control-flow analysis cannot see.
  const outcome: { reason: PrintResult["reason"]; errorMessage?: string } = {
    reason: "completed",
  };

  const unsubscribe = runtime.subscribe((event: AgentEvent) => {
    if (format === "json") out(`${JSON.stringify(event)}\n`);
    if (event.type === "notice" && format !== "json" && event.level !== "info") {
      err(`arcturn: ${event.text}\n`);
    }
    if (event.type === "runEnd") {
      outcome.reason = event.reason;
      outcome.errorMessage = event.errorMessage;
    }
  });

  try {
    // @-mentions expand here rather than at the call site, so print mode
    // behaves exactly like the interactive app for every caller. A skill's
    // expanded body is exempt: the interactive path hands it to the agent
    // verbatim, and a skill that documents an `@name` convention must not
    // suddenly start inlining files under `-p`.
    const expanded =
      skillPrompt !== undefined
        ? undefined
        : typeof prompt === "string"
          ? await expandMentions(prompt, runtime.cwd)
          : undefined;
    await runtime.agent.prompt(
      skillPrompt !== undefined
        ? skillPrompt
        : expanded === undefined
          ? prompt
          : expanded.images.length > 0
            ? [textBlock(expanded.text), ...expanded.images]
            : expanded.text,
    );
  } finally {
    unsubscribe();
  }

  const text = runtime.agent.finalText();
  if (format === "text") {
    if (text.length > 0) out(text.endsWith("\n") ? text : `${text}\n`);
    if (outcome.reason === "error" && outcome.errorMessage) {
      err(`arcturn: ${outcome.errorMessage}\n`);
    }
    if (outcome.reason === "aborted") err("arcturn: interrupted\n");
  }

  return {
    exitCode: outcome.reason === "completed" ? 0 : 1,
    text,
    reason: outcome.reason,
    ...(outcome.errorMessage === undefined ? {} : { errorMessage: outcome.errorMessage }),
  };
}

/**
 * The prompt a `/<name> args` line expands to when `<name>` is a markdown
 * skill, or `undefined` when it is anything else.
 *
 * The registry is consulted rather than `runtime.skills` alone because a
 * built-in command of the same name wins registration (see
 * `createCommandRegistry`'s collision guard): a user skill called `skills`
 * must still run the built-in `/skills` command here, exactly as it does in
 * the terminal.
 *
 * @param input - The trimmed command line, leading slash included.
 * @param runtime - The runtime whose skills and cwd the prompt is built from.
 * @param registry - The registry the line would otherwise dispatch through.
 */
function skillPromptFor(
  input: string,
  runtime: ArcturnRuntime,
  registry: CommandRegistry,
): string | undefined {
  const parsed = parseCommandLine(input);
  if (!parsed) return undefined;
  const skill = runtime.skills.find((candidate) => candidate.name === parsed.name);
  if (!skill) return undefined;
  if (registry.get(parsed.name)?.source !== skill.source) return undefined;
  return skill.buildPrompt(parsed.args, runtime.cwd);
}

/**
 * Run one slash command with no terminal behind it.
 *
 * The interactive app hands a command a transcript, a modal picker and an
 * editor to pre-fill. None of those exist here, so each degrades to the
 * honest equivalent: the transcript is stdout, a picker is refused with a
 * notice naming what to pass instead, and a pre-filled follow-up is printed
 * as the command to run next. Nothing is invented on the command's behalf.
 */
async function runPrintCommand(
  input: string,
  options: RunPrintOptions,
  format: OutputFormat,
  out: (chunk: string) => void,
  err: (chunk: string) => void,
  registry: CommandRegistry,
): Promise<PrintResult> {
  const { runtime } = options;
  const seen = { error: false, needsHuman: false };
  const emit = (record: Record<string, unknown>): void => out(`${JSON.stringify(record)}\n`);
  const ui: CommandUi = {
    print(content) {
      const lines = typeof content === "string" ? [content] : [...content];
      if (format === "json") emit({ type: "print", lines });
      else out(`${lines.join("\n")}\n`);
    },
    notice(level, text) {
      if (level === "error") seen.error = true;
      if (isWorkflowHumanStop(text)) seen.needsHuman = true;
      if (format === "json") emit({ type: "notice", level, text });
      else if (level === "info") out(`${text}\n`);
      else err(`arcturn: ${text}\n`);
    },
    async select(title) {
      // A picker needs a person. Say so, name the surface, and let the
      // command take the "cancelled" branch it already has for Esc — unless
      // a human-stop notice has already printed the resume hint, in which
      // case this refusal is redundant noise on top of it.
      if (!seen.needsHuman) {
        ui.notice("warn", `${title}: a picker cannot be shown under --print.`);
      }
      return undefined;
    },
    setInput(text) {
      const next = text.trim();
      if (next !== "") err(`arcturn: next: arcturn -p ${JSON.stringify(next)}\n`);
    },
    clear() {},
    exit() {},
    needsHuman() {
      seen.needsHuman = true;
    },
    ...(format === "json" ? { workflowLive: (event) => emit({ type: "workflow", event }) } : {}),
  };
  const result = await registry.dispatch(input, { runtime, ui });
  // A park is resumable — that is the whole point — so it takes priority
  // over an error notice a failed step reported on its way to parking.
  const exitCode =
    "unknown" in result && result.unknown === true
      ? PRINT_EXIT.unknownCommand
      : seen.needsHuman
        ? PRINT_EXIT.needsHuman
        : seen.error
          ? PRINT_EXIT.error
          : PRINT_EXIT.ok;
  return {
    exitCode,
    text: "",
    reason:
      exitCode === PRINT_EXIT.ok || exitCode === PRINT_EXIT.needsHuman ? "completed" : "error",
    ...(exitCode === PRINT_EXIT.unknownCommand
      ? { errorMessage: `unknown command ${input.split(/\s+/)[0]}` }
      : {}),
  };
}
