/**
 * SESSION TITLES — name a session with one small LLM call after its first
 * completed run, so `/sessions` and the recent-sessions splash can show
 * "Fixing the login redirect" instead of a bare session id.
 *
 * The generator is a fire-once-per-session state machine over the
 * {@link AgentEvent} stream: it captures the first user prompt at `runStart`,
 * the last assistant text at `messageEnd`, and fires on the first `runEnd`
 * with `reason: "completed"`. An errored or aborted run leaves it armed —
 * the session has not really had a first exchange yet — and once it has
 * attempted a title it never retries within that session: a second guess at
 * a name nobody complained about is spend with no upside.
 *
 * This module intentionally has no dependency on `runtime.ts` (the
 * `cost-guard.ts` mould): the LLM call, the config kill switch and the
 * session-store lookup are all injected via {@link TitleGeneratorDeps}, so
 * the machine is testable with a synthetic event stream. The wiring lives in
 * `buildRuntime`, beside the cost guard. Every dep receives the session id
 * the trigger CAPTURED, not "the current session" — the title call is
 * fire-and-forget, and a `/clear` racing it must not get the old session's
 * title stamped onto the new session.
 */

import type { AgentEvent, Message } from "@arcturn/types";

/** Longest title written to a session header, in characters. */
export const TITLE_MAX_CHARS = 60;

/** Cap on the prompt/reply text handed to the title model, per side. */
export const TITLE_INPUT_CAP_CHARS = 2_000;

/** Output budget for the title call — a few words, never an essay. */
export const TITLE_MAX_OUTPUT_TOKENS = 64;

/** System prompt for the title call (the wiring in `runtime.ts` sends it). */
export const TITLE_SYSTEM_PROMPT =
  "You name coding sessions. Given the opening exchange of a session, output ONLY a title " +
  "for it: a noun phrase of 3 to 8 words. No surrounding quotes, no trailing period, no " +
  "markdown, no explanation.";

/**
 * The user-message body for the title call, from the (already capped)
 * prompt and reply text. Exported so the wiring and its tests agree on the
 * exact wording without duplicating it.
 *
 * @param promptText - The session's first user prompt.
 * @param replyText - The assistant's answer to it; may be empty.
 */
export function titleRequestPrompt(promptText: string, replyText: string): string {
  const parts = ["The session opened with this request:", "", promptText];
  if (replyText !== "") {
    parts.push("", "The assistant answered:", "", replyText);
  }
  return parts.join("\n");
}

/**
 * Normalise a model's raw title suggestion into something a session header
 * can carry: fences and wrapping quotes stripped (models add both no matter
 * how firmly the prompt forbids them — same defence as `cleanCommitMessage`
 * in `git.ts`), whitespace collapsed to one line, and length capped at
 * {@link TITLE_MAX_CHARS} with the cut made at a word boundary plus an
 * ellipsis rather than mid-word.
 *
 * @param raw - The model's output, verbatim.
 * @returns The cleaned title; empty when the model produced nothing usable.
 */
export function cleanTitle(raw: string): string {
  let text = raw.trim();
  const fence = /^```[^\n]*\n([\s\S]*?)\n?```$/.exec(text);
  if (fence) text = (fence[1] ?? "").trim();
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    text = text.slice(1, -1).trim();
  }
  text = text.replace(/\s+/g, " ").trim();
  if (text.length > TITLE_MAX_CHARS) {
    // Leave room for the ellipsis, and prefer the last word boundary before
    // the cap — unless that boundary is so early the title would vanish.
    const limit = TITLE_MAX_CHARS - 1;
    const boundary = text.lastIndexOf(" ", limit);
    text = `${text.slice(0, boundary > TITLE_MAX_CHARS / 2 ? boundary : limit).trimEnd()}…`;
  }
  return text;
}

/** What the title generator needs from its host. */
export interface TitleGeneratorDeps {
  /**
   * Whether this session should be titled at all: the feature is enabled and
   * the STORED header carries no title yet. Read lazily at trigger time —
   * never cached — so a header written moments ago (a resumed session, a
   * `subagent:`/`background:` scratch session, a title another process just
   * wrote) is honoured.
   *
   * @param sessionId - The session the completed run belonged to.
   */
  shouldTitle(sessionId: string): boolean | Promise<boolean>;
  /**
   * Produce a raw title suggestion — in production, one `llm.complete` call
   * on the `title` route. The inputs arrive already capped to
   * {@link TITLE_INPUT_CAP_CHARS} per side.
   *
   * @param promptText - The session's first user prompt.
   * @param replyText - The assistant's final text for that run; may be empty.
   */
  generate(promptText: string, replyText: string): Promise<string>;
  /**
   * Write the cleaned title onto the session header.
   *
   * @param sessionId - The session the title belongs to.
   * @param title - Cleaned, non-empty title.
   */
  setTitle(sessionId: string, title: string): Promise<void>;
}

/** Handle returned by {@link createTitleGenerator}. */
export interface TitleGenerator {
  /** Feed one runtime event through the generator. */
  onEvent(event: AgentEvent): void;
  /**
   * Forget everything and re-arm, for a session swap. `onEvent` also
   * re-arms itself when a `runStart` names a different session id, so a
   * host whose event stream already spans swaps (the runtime's own
   * subscription does) never *needs* to call this — it exists for hosts
   * that swap without a fresh `runStart` in between.
   */
  reset(): void;
}

/** The user-visible text of a message, or `""` for non-user shapes. */
function textOf(message: Message): string {
  if (message.role !== "user" && message.role !== "assistant") return "";
  return message.content
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n")
    .trim();
}

/**
 * Build a title generator over injected deps. See the module doc for the
 * state machine's contract; the one behavior worth restating is that the
 * whole title path is fire-and-forget — `onEvent` returns before any dep
 * resolves, and every failure is swallowed, because a missing title must
 * never break (or even slow) a run.
 *
 * @param deps - Host hooks; see {@link TitleGeneratorDeps}.
 */
export function createTitleGenerator(deps: TitleGeneratorDeps): TitleGenerator {
  let sessionId: string | undefined;
  let promptText = "";
  let replyText = "";
  let attempted = false;

  function reset(): void {
    sessionId = undefined;
    promptText = "";
    replyText = "";
    attempted = false;
  }

  return {
    onEvent(event: AgentEvent): void {
      if (event.type === "runStart") {
        // A different session id means the host swapped agents (`/clear`,
        // `/sessions`): drop the old capture and start fresh, so the NEW
        // session is titled from its own first exchange.
        if (sessionId !== event.sessionId) {
          reset();
          sessionId = event.sessionId;
        }
        if (promptText === "") promptText = textOf(event.prompt);
        return;
      }
      if (event.type === "messageEnd") {
        // Once the attempt is spent, no message text in this session can ever
        // be used again — don't even extract it. A new session re-arms via
        // the runStart branch above (which resets `attempted`), never here.
        if (attempted) return;
        // The last non-empty assistant text of the run is its answer;
        // intermediate tool-call turns often say nothing.
        const text = textOf(event.message);
        if (text !== "") replyText = text;
        return;
      }
      if (event.type !== "runEnd" || event.reason !== "completed") return;
      if (attempted || sessionId === undefined) return;
      // No user text yet (an empty prompt shape) — stay armed for the first
      // run that actually says something.
      if (promptText === "") return;
      attempted = true;
      const id = sessionId;
      const prompt = promptText.slice(0, TITLE_INPUT_CAP_CHARS);
      const reply = replyText.slice(0, TITLE_INPUT_CAP_CHARS);
      void (async () => {
        if (!(await deps.shouldTitle(id))) return;
        const title = cleanTitle(await deps.generate(prompt, reply));
        if (title === "") return;
        await deps.setTitle(id, title);
      })().catch(() => undefined);
    },
    reset,
  };
}
