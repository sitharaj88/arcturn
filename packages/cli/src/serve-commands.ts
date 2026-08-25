/**
 * What `listCommands` answers with on the serve path: the workspace's markdown
 * skills, plus the built-ins a remote client can actually reach.
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

import { REMOTE_REACHABLE_BUILT_IN_COMMANDS } from "@arcturn/server";
import type { CommandDescriptor } from "@arcturn/types";
import { sanitizeDescription } from "./skill-tool.js";
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
