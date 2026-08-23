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
import { expandMentions } from "./mentions.js";
import type { ArcturnRuntime } from "./runtime.js";

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
}

/** Result of a `--print` run. */
export interface PrintResult {
  /** Process exit code: `0` on success, `1` on error or abort. */
  exitCode: number;
  /** The final assistant text, also written to stdout in text mode. */
  text: string;
  /** Why the run stopped. */
  reason: "completed" | "aborted" | "error";
  /** Populated when `reason` is `"error"`. */
  errorMessage?: string;
}

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
    // behaves exactly like the interactive app for every caller.
    const expanded =
      typeof prompt === "string" ? await expandMentions(prompt, runtime.cwd) : undefined;
    await runtime.agent.prompt(
      expanded === undefined
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
