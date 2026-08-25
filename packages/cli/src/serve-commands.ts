/**
 * The serve path's commands: what `listCommands` answers with, and what a
 * leading `/name` on a prompt actually does.
 *
 * Both halves live here on purpose. RFC 0005 §3 forbids a menu that lies, and
 * the cheapest way to build one is to keep the list in one file and the
 * execution in another: the list grows an entry, the executor never learns
 * about it, and a client renders a command that does nothing. Here the same
 * module answers "what exists" ({@link serveCommandDescriptors}) and "what
 * happens when you send it" ({@link expandServedCommand}), reading the same
 * two inputs — the discovered skills, and
 * `@arcturn/server`'s {@link REMOTE_REACHABLE_BUILT_IN_COMMANDS}.
 *
 * Split out of `serve.ts` because it is the *composition* of two lists that
 * are each owned elsewhere — `loadSkills` discovers the skills, and
 * `@arcturn/server`'s {@link REMOTE_REACHABLE_BUILT_IN_COMMANDS} decides which
 * built-ins the wire can carry out (which is the package that knows, since the
 * answer is "which verbs exist"). Nothing here re-derives either.
 *
 * ## Descriptions are sanitized, and only that
 *
 * A skill's `description` is untrusted markdown: `<cwd>/.arcturn/skills` is a
 * directory a cloned repository controls. `skill-tool.ts` already sanitizes it
 * on the way to the *model* — first line only, control characters collapsed,
 * length-capped — and the same function is reused here rather than a second
 * one written, because it is the same string from the same file.
 *
 * What is deliberately **not** reused is that module's stronger treatment for
 * an untrusted skill: `createSkillTool` withholds a project-root skill's
 * description entirely. That rule exists because the model index rides in
 * every request with **no user action at all**, so an attacker-controlled
 * sentence gets read by the model for free. A `/` menu is the opposite shape:
 * a person reads the line, and it becomes prompt text only when they choose
 * the command. Withholding there would leave a user picking commands blind,
 * which is a worse outcome than the one it would prevent — so the description
 * is shown, sanitized, next to {@link CommandDescriptor.source}, the absolute
 * path it came from, so provenance is visible rather than implied.
 */

import { REMOTE_BUILT_IN_COMMAND_VERBS, REMOTE_REACHABLE_BUILT_IN_COMMANDS } from "@arcturn/server";
import type { CommandDescriptor } from "@arcturn/types";
import { parseCommandLine } from "./commands.js";
import { nearestMatches, sanitizeDescription } from "./skill-tool.js";
import type { Skill } from "./skills.js";

/**
 * Build the `listCommands` payload.
 *
 * Ordered the way RFC 0005 §2 wants the menu rendered — skills first,
 * alphabetically, then the built-ins in their own fixed order — so every
 * client's `/` menu agrees without each one inventing a sort.
 *
 * A skill with no `description` frontmatter gets one naming its file, matching
 * what `skillCommand` shows in the terminal's `/help`: a nameless row in a
 * menu is a row nobody can choose with any confidence.
 *
 * @param skills - The discovered skill collection (`ArcturnRuntime.skills`).
 * @returns Descriptors, ready for the wire.
 */
export function serveCommandDescriptors(skills: readonly Skill[]): CommandDescriptor[] {
  const fromSkills = [...skills]
    .filter((skill) => !shadowedByBuiltIn(skill.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((skill): CommandDescriptor => {
      const description = sanitizeDescription(skill.description);
      return {
        name: skill.name,
        description: description === "" ? `Skill from ${skill.source}` : description,
        kind: "skill",
        source: skill.source,
      };
    });
  return [...fromSkills, ...REMOTE_REACHABLE_BUILT_IN_COMMANDS.map((command) => ({ ...command }))];
}

/**
 * What a leading `/name` on a served prompt turned out to be.
 *
 * A union rather than a throw so this module stays free of the server's error
 * types and can be tested by reading a value; `context.ts` is where a
 * `"refused"` becomes a `ContextRefusedError` and therefore an `invalidRequest`
 * on the wire.
 */
export type ServedCommandExpansion =
  /** Not a command line at all. The prompt is prose; treat it as typed. */
  | { outcome: "notACommand" }
  /** A skill, expanded. `text` replaces the prompt entirely. */
  | { outcome: "expanded"; name: string; text: string }
  /** A command attempt that cannot be honoured. Fatal — no turn is spent. */
  | { outcome: "refused"; name: string; reason: string };

/**
 * Whether a name belongs to a listed built-in, and so is not a skill's to take.
 *
 * `createCommandRegistry` registers the built-ins first and skips a skill whose
 * name is already defined, warning as it goes — so in the terminal a skill
 * called `model` is inert and `/model` opens the model picker. The serve path
 * has to agree, on both halves: the name is listed once, as the built-in, and
 * `/model` resolves to the built-in. Letting the skill win here would give one
 * name two behaviours depending on which surface you were sitting at, which is
 * the divergence RFC 0004 §0 exists to prevent.
 *
 * The lookup is `find` over the frozen array rather than a key test against an
 * object, so a name like `constructor` cannot match something off a prototype.
 *
 * Scoped to the built-ins **this wire** lists. The terminal has more of them,
 * and a skill named `rewind` is shadowed there while working here — but that is
 * a property of the reachable-subset rule `listCommands` is built on, not
 * something this function can fix without inventing a `/rewind` the wire cannot
 * run.
 *
 * @param name - A normalized command name, without its slash.
 */
function shadowedByBuiltIn(name: string): boolean {
  return REMOTE_REACHABLE_BUILT_IN_COMMANDS.some((command) => command.name === name);
}

/** Render a verb list as prose: `listModels` / `listModels or setModel`. */
function verbPhrase(verbs: readonly string[]): string {
  if (verbs.length <= 1) return `the ${verbs[0] ?? "matching"} verb`;
  return `the ${verbs.slice(0, -1).join(", ")} and ${verbs[verbs.length - 1]} verbs`;
}

/**
 * Expand a leading `/name [args]` on a served prompt into the skill's body.
 *
 * This is the execution half of {@link serveCommandDescriptors}: RFC 0005 §1.3
 * keeps execution on `prompt` — a skill is prompt text, and a second execution
 * verb would give one skill two behaviours — so the expansion the TUI's command
 * registry performs has to happen somewhere on this path, and this is it.
 *
 * ## What is reused, and what is decided here
 *
 * The expansion itself is {@link Skill.buildPrompt} — the same method
 * `skillCommand` drives for `/name` in the terminal and the model-invoked
 * `skill` tool returns, so `$ARGUMENTS`/`$1`../`$CWD`/`$SKILL_DIR` cannot mean
 * one thing here and another there. The split into name and arguments is
 * {@link parseCommandLine}, shared with `CommandRegistry.dispatch` for the same
 * reason. Nothing about a skill is re-parsed, re-read or re-substituted here.
 *
 * ## Three decisions, written down because they are divergences or nearly so
 *
 * **Mentions are not expanded afterwards.** A skill's body — and any
 * `@mention` sitting in the arguments — reaches the model as written. That is
 * what the terminal does (`skillCommand` calls `agent.prompt` directly, never
 * `expandMentions`), and matching it is not merely consistency: a skill in
 * `<cwd>/.arcturn/skills` is a file a cloned repository controls, so expanding
 * its mentions would let a repo pull `@.env` into a prompt on the strength of
 * someone running `/review`. The prompt path expands the mentions a *person*
 * typed; a command's body is not that.
 *
 * **A `/name` that is not leading is left alone**, as in the terminal: only a
 * line whose first non-space character is `/` is a command.
 *
 * **A malformed name is prose, not a failed command** — the one place this
 * knowingly diverges from `CommandRegistry.dispatch`, which treats every
 * leading slash as a command attempt and warns "Unknown command" at anything
 * it does not know. That is right in a terminal, where a completion menu is
 * open as you type. It is wrong in a chat composer, where `/etc/hosts has the
 * wrong entry` and `/usr/local is on the wrong volume` are things people
 * genuinely send. So the command shape is narrowed to `[A-Za-z0-9-]+`
 * terminated by whitespace or end of line — the charset a skill name is
 * normalized into — and anything else falls through as prose. `/notacommand`
 * still refuses, because that is a typo rather than prose; `/etc/hosts` does
 * not, because it is not a name.
 *
 * @param text - The prompt text, exactly as it arrived from the wire.
 * @param skills - The discovered skill collection — the same array
 *   {@link serveCommandDescriptors} lists from.
 * @param cwd - The session's working directory, for `$CWD`.
 */
export function expandServedCommand(
  text: string,
  skills: readonly Skill[],
  cwd: string,
): ServedCommandExpansion {
  const parsed = parseCommandLine(text);
  if (!parsed?.wellFormed) return { outcome: "notACommand" };

  // Built-ins first, exactly as `createCommandRegistry` registers them first and
  // then skips a skill that would collide. See {@link shadowedByBuiltIn}.
  if (shadowedByBuiltIn(parsed.name)) {
    const verbs = Object.hasOwn(REMOTE_BUILT_IN_COMMAND_VERBS, parsed.name)
      ? REMOTE_BUILT_IN_COMMAND_VERBS[parsed.name]
      : undefined;
    return {
      outcome: "refused",
      name: parsed.name,
      reason:
        `/${parsed.name} is a built-in command, not prompt text: run it with ` +
        `${verbPhrase(verbs ?? [])}, which is what listCommands means by kind:"builtin". ` +
        "Nothing was sent and no turn was spent.",
    };
  }

  // Matched by NAME against what the engine itself discovered. The wire never
  // names a path, so there is no path here to confine: a skill file outside
  // `loadSkills`' roots is not addressable from a client at all, and neither
  // `..`, an absolute path, nor a symlink is a name this lookup can hit.
  const skill = skills.find((candidate) => candidate.name === parsed.name);
  if (skill) {
    return { outcome: "expanded", name: skill.name, text: skill.buildPrompt(parsed.args, cwd) };
  }

  // Unknown, and refused rather than passed through. Sending it as prose is the
  // one outcome RFC 0005 §3 rules out: the model reads a slash-word it can do
  // nothing with, answers something, and the user is left unable to tell a
  // command that ran from one that never existed.
  const suggestions = nearestMatches(parsed.name, [
    ...skills,
    ...REMOTE_REACHABLE_BUILT_IN_COMMANDS,
  ]);
  const hint =
    suggestions.length > 0
      ? ` Did you mean ${suggestions.map((name) => `/${name}`).join(", ")}?`
      : "";
  return {
    outcome: "refused",
    name: parsed.name,
    reason:
      `No command named /${parsed.name} exists in this workspace.${hint} ` +
      "Ask listCommands for the current list, or rephrase so the prompt does not " +
      "start with a slash if it was meant as prose. Nothing was sent and no turn was spent.",
  };
}
