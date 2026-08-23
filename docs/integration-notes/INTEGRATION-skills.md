# Wiring markdown skills into the command registry

This describes how the orchestrator should connect `packages/cli/src/skills.ts`
(`loadSkills`) to the existing command pipeline in `packages/cli/src/commands.ts`
and `packages/cli/src/extensions.ts`. `skills.ts` and `skills.test.ts` are the
only files added for this feature; nothing else was touched.

## What `loadSkills` produces

```ts
export interface Skill {
  name: string;                 // already normalized: lowercase, [a-z0-9-] only
  description: string;          // "" if the file set none
  source: string;                // absolute path of the .md / SKILL.md file
  buildPrompt(args: string, cwd: string): string;
}

export async function loadSkills(
  roots: readonly string[],
  warnings: string[],
): Promise<Skill[]>;
```

`loadSkills` is directory-agnostic: it takes whatever roots you hand it, in
priority order (later root wins a name collision), and returns fully parsed,
ready-to-run skills plus warnings pushed onto the array you pass in — the same
"warnings collector" convention `config.ts` and `extensions.ts` already use.

## Directories to pass

Call it with the user root first, project root second, exactly like
`loadExtensions`'s `directories` option and `parseConfigFile`'s scope
layering:

```ts
await loadSkills(
  [join(paths.home, "skills"), join(paths.project, "skills")],
  warnings,
);
```

i.e. `~/.arcturn/skills` and `<cwd>/.arcturn/skills` (using the already-resolved
`ArcturnPaths.home` / `ArcturnPaths.project` from `paths.ts` — `resolveArcturnPaths` was
not modified, so the orchestrator computes `join(paths.home, "skills")` /
`join(paths.project, "skills")` itself, the same way `paths.userExtensions`
sits next to `paths.userConfig`). A missing directory is silently fine, so
this call is safe to make unconditionally, mirroring how `loadExtensions`
scans `paths.userExtensions` / `paths.projectExtensions` unconditionally.

## Turning a `Skill` into a `SlashCommand`

`createCommandRegistry` (in `commands.ts`) already accepts a third-party
command shape through `ExtensionCommand`:

```ts
export interface ExtensionCommand {
  name: string;
  description: string;
  handler: ExtensionCommandHandler; // (context: CommandContext) => void | Promise<void>
  source: string;
}
```

and registers each one as:

```ts
registry.register({
  name: command.name,
  description: command.description,
  source: command.source,
  run: (context) => command.handler(context),
});
```

with collisions against a name already in the registry rejected (and warned)
— extension commands cannot shadow a built-in, and by the same mechanism a
skill loaded after extension commands cannot shadow either a built-in or an
already-registered extension command. **This is intentionally not
`skills.ts`'s concern**: `loadSkills` only resolves collisions *among
skills*; the registry resolves collisions between skills and everything
else, exactly as it already does for extensions.

A `Skill` maps onto `ExtensionCommand` with a one-line adapter, because a
skill's "handler" is just: expand the template with the live args/cwd, then
feed the result back into the agent as if the user had typed it. The
orchestrator should write this adapter (not part of `skills.ts`, since
`skills.ts` must not import `commands.ts` or vice versa — avoiding a
dependency cycle and keeping `skills.ts` UI-agnostic):

```ts
import { loadSkills } from "./skills.js";
import type { ExtensionCommand } from "./extensions.js";

function skillsToExtensionCommands(skills: readonly Skill[]): ExtensionCommand[] {
  return skills.map((skill) => ({
    name: skill.name,
    description: skill.description || `Skill from ${skill.source}`,
    source: skill.source,
    handler: (context) => {
      const prompt = skill.buildPrompt(context.args, context.runtime.cwd);
      // Feed the expanded prompt back through the same path a typed message
      // takes, e.g. context.runtime.agent.send(prompt) / equivalent submit
      // hook the interactive app already uses for plain user input.
      return context.runtime.agent.send(prompt);
    },
  }));
}
```

(The exact call to hand the expanded prompt to the agent should match
whatever `packages/cli/src/interactive/app.ts` already calls for a normal,
non-slash user message — so a skill invocation behaves identically to the
user pasting the expanded text and hitting enter.)

Then wire it in wherever `createCommandRegistry` is currently called (e.g. in
`runtime.ts` or `main.ts`, wherever `loadExtensions`'s result is turned into
`host.commands` today):

```ts
const skillWarnings: string[] = [];
const skills = await loadSkills(
  [join(paths.home, "skills"), join(paths.project, "skills")],
  skillWarnings,
);
for (const warning of skillWarnings) warn(warning); // same sink extension/config warnings use

const registry = createCommandRegistry(
  [...extensionHost.commands, ...skillsToExtensionCommands(skills)],
  warn,
);
```

Order matters only for the *built-in vs. everything else* rule already
enforced by `createCommandRegistry`; whether extension commands or skill
commands are concatenated first just decides which one wins when an
extension and a skill both claim the same name (first in the array loses,
per the existing `if (registry.get(command.name))` guard) — pick whichever
order matches the priority you want extensions vs. skills to have relative to
each other. Skill-vs-skill collisions are already resolved before this point,
inside `loadSkills`.

## Summary of division of responsibility

| Concern | Owner |
|---|---|
| Discover `.md` / `SKILL.md` files, parse frontmatter, expand `$ARGUMENTS`/`$1..$9`/`$CWD`/`$SKILL_DIR`, resolve skill-vs-skill name collisions | `skills.ts` (`loadSkills`) |
| Turn a `Skill` into something registrable (call `buildPrompt`, feed result to the agent) | orchestrator adapter (new, small, lives next to wherever extensions are wired up — not `skills.ts`) |
| Reject/warn on a skill colliding with a built-in or an extension command | `commands.ts`'s existing `createCommandRegistry` guard — unchanged, no new code needed |
