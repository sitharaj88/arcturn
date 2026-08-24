/**
 * `arcturn new skill|agent|workflow <name>` — write one starter file that the
 * real parsers accept.
 *
 * The author loop RFC 0002 describes is scaffold → edit → `arcturn inspect .`
 * → `arcturn add .`, and this is its first step. It exists because the three
 * markdown formats Arcturn reads are simple but *strict*, and their rules are
 * spread across three loaders: an agent with no `tools:` line is refused by the
 * workflow engine outright, a workflow's steps must be numbered consecutively
 * from 1 with no continuation lines, a skill with an empty body is skipped with
 * a warning nobody reads. Learning that by trial and error is a bad first hour.
 *
 * Two rules shape every template here:
 *
 * 1. **It must parse.** `scaffold.test.ts` round-trips each generated file
 *    through `loadAgentDefs`, `parseWorkflow` and `loadSkills` — the same
 *    functions the runtime uses — rather than asserting on the template text.
 *    A template that drifts out of the format fails there, not in a user's
 *    first session.
 * 2. **The comments teach the format, not the product.** Each file explains
 *    the rules that will bite: that `tools:` decides which *lane* the workflow
 *    engine dispatches a role on (`roleDispatch` in `workflow.ts`), that
 *    `budgetUsd:` caps what a whole run may spend, that a skill body is a
 *    prompt template expanded on every invocation. Those comments live inside
 *    the frontmatter (where every loader ignores an unrecognised key) or, for a
 *    workflow, above the first numbered line (the one region its parser treats
 *    as documentation) — so the teaching costs the model nothing at run time.
 *
 * Names are validated as a single `[a-z0-9-]` path segment before anything is
 * written: that is the charset all three loaders normalise a name to, so the
 * file's stem is exactly what the loader will call it, and it forecloses path
 * traversal by construction rather than by a later containment check (which is
 * still applied, as defense in depth).
 *
 * Nothing here overwrites: an existing file is a refusal, never a merge.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";

/** What `arcturn new` can create. */
export type ScaffoldKind = "skill" | "agent" | "workflow";

/** Every kind, in help-text order. */
export const SCAFFOLD_KINDS: readonly ScaffoldKind[] = ["skill", "agent", "workflow"];

/** Which root a scaffolded file lands in. */
export type ScaffoldScope = "project" | "user";

/**
 * Any refusal from the scaffolder.
 *
 * {@link ScaffoldError.usage} separates "you asked for something impossible"
 * (a bad kind or name — exit 2, the shell convention for a usage error) from
 * "what you asked for cannot be done here" (the file already exists — exit 1),
 * so a caller need not pattern-match on the message to pick an exit code.
 */
export class ScaffoldError extends Error {
  /** `true` when the request itself was malformed. */
  readonly usage: boolean;

  constructor(message: string, usage = false) {
    super(message);
    this.name = "ScaffoldError";
    this.usage = usage;
  }
}

/** Options for {@link scaffold}. */
export interface ScaffoldOptions {
  /** What to create. */
  kind: ScaffoldKind;
  /** File stem and default frontmatter `name:`; a single `[a-z0-9-]` segment. */
  name: string;
  /** `"project"` (default) writes to `<cwd>/.arcturn`; `"user"` writes to the Arcturn home. */
  scope?: ScaffoldScope;
  /** Project working directory. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Arcturn user directory. Defaults to `~/.arcturn`. */
  home?: string;
}

/** What {@link scaffold} wrote. */
export interface ScaffoldResult {
  kind: ScaffoldKind;
  name: string;
  scope: ScaffoldScope;
  /** Absolute path of the file created. */
  file: string;
}

/** The directory each kind is discovered in, under either root. */
const KIND_DIRS: Readonly<Record<ScaffoldKind, string>> = {
  skill: "skills",
  agent: "agents",
  workflow: "workflows",
};

/**
 * The charset every loader normalises a name to.
 *
 * Requiring it up front (rather than normalising silently) means the filename,
 * the frontmatter `name:`, and the name the loader reports are the same string
 * — so `/reviewer` really is the file called `reviewer.md`, and nobody has to
 * discover that `My Reviewer.md` became `myreviewer`.
 */
const SAFE_NAME = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Narrow an arbitrary word to a {@link ScaffoldKind}.
 *
 * @param value - Candidate word.
 */
export function isScaffoldKind(value: string): value is ScaffoldKind {
  return (SCAFFOLD_KINDS as readonly string[]).includes(value);
}

const AGENT_TEMPLATE = (name: string): string => `---
name: ${name}
description: One line, shown to the model when it is choosing an agent to delegate to.
tools: read, grep, glob, ls
# "tools:" is this role's whole security story, and it decides the LANE the
# workflow engine dispatches it on:
#   write / edit / multiedit  -> WRITE lane: the role runs in its own worktree
#                                and its diff is replayed into your checkout.
#   bash, without any of those -> EXEC lane: the same isolation, but the diff is
#                                discarded unread — for building, testing, auditing.
#   neither                    -> READ lane: an ordinary sub-agent, no worktree.
# A role with NO "tools:" line is refused by a workflow rather than guessed at,
# because an undeclared tool set is whatever the session has, not nothing.
# Optional, uncomment to use:
# model: anthropic/claude-opus-5
# maxTurns: 20
---

You are ${name}.

Everything below the frontmatter is this role's system prompt, used verbatim —
there is no argument substitution, because a role is given a task, not typed as
a command.

Replace this text with: what the role is for, what evidence it must produce
before it claims anything, and what it must refuse to do. Be explicit about the
output format; this prompt is the whole instruction the delegate ever gets.
`;

const WORKFLOW_TEMPLATE = (name: string): string => `---
name: ${name}
description: One line, shown by "/workflow list".
continueOnError: false
budgetUsd: 5
---
Everything above the first numbered line is documentation — the parser ignores
it. Run this file with "/workflow ${name} <your input>".

budgetUsd caps what the whole run may spend in US dollars, across every step and
every retry, and the run aborts the moment that ceiling is crossed. Delete the
line and there is no ceiling at all.

A step is exactly one numbered line, numbered consecutively from 1; there are no
continuation lines. {{input}} is the text typed after the workflow name, and
{{prev}} is the previous stage's combined output — it has no value in step 1.

Prefix a step with @role to hand it to an agent file in .arcturn/agents/. That
role's own tools: line then decides which lane the step runs on, so a step is
never more privileged than the role written to run it.

Indent "-" bullets under a numbered line to run those branches concurrently, and
end the numbered line with ":" to make it their label.

1. Read the request below and state, in full, the plan and the check that will prove it worked: {{input}}
2. Carry out the plan below, then report exactly what changed and the command output that verifies it: {{prev}}
`;

const SKILL_TEMPLATE = (name: string): string => `---
name: ${name}
description: One line of help text, shown in the "/" command palette.
# The body below is a prompt TEMPLATE, expanded fresh on every invocation:
#   $ARGUMENTS  everything typed after the command name
#   $1 .. $9    positional arguments (a "double-quoted span" counts as one)
#   $CWD        the working directory the command ran in
#   $SKILL_DIR  this folder's path — folder skills (<name>/SKILL.md) only
# A skill is a prompt, not code: what you write here is sent to the model with
# your permissions, so treat it as something you are saying out loud.
---

Replace this body with the prompt "/${name}" should send.

Arguments: $ARGUMENTS

Working directory: $CWD
`;

/**
 * What to do with the file that was just written.
 *
 * A next step is only worth printing if it works from where the person is
 * standing. `arcturn inspect ./.arcturn` does — a project's `.arcturn`
 * directory holds `skills/`, `agents/` and `workflows/`, which is exactly the
 * package layout the registry detects by convention, so the project's own
 * config directory can be read back with the same disclosure a stranger's
 * package gets. The `./` is load-bearing: `resolveSource` recognises a local
 * path by its prefix, and a bare `.arcturn` parses as neither a path nor an
 * `owner/repo` shorthand.
 */
const NEXT_STEPS: Readonly<Record<ScaffoldKind, (name: string) => string>> = {
  skill: (name) => `Edit it, then run "/${name}" in a session.`,
  agent: (name) =>
    `Edit it, then name it "@${name}" in a workflow step. ` +
    `"arcturn inspect ./.arcturn" shows the lane its tools: line gives it.`,
  workflow: (name) => `Edit it, then run "/workflow ${name} <your input>" in a session.`,
};

const TEMPLATES: Readonly<Record<ScaffoldKind, (name: string) => string>> = {
  agent: AGENT_TEMPLATE,
  workflow: WORKFLOW_TEMPLATE,
  skill: SKILL_TEMPLATE,
};

/**
 * Resolve the directory a scaffolded file of this kind and scope belongs in.
 *
 * @param kind - What is being created.
 * @param scope - Which root to write into.
 * @param cwd - Project working directory.
 * @param home - Arcturn user directory.
 */
export function scaffoldDir(
  kind: ScaffoldKind,
  scope: ScaffoldScope,
  cwd: string,
  home: string,
): string {
  const root = scope === "user" ? resolve(home) : join(resolve(cwd), ".arcturn");
  return join(root, KIND_DIRS[kind]);
}

/**
 * Write one starter file, refusing to overwrite anything.
 *
 * @param options - See {@link ScaffoldOptions}.
 * @returns Where the file was written.
 * @throws {ScaffoldError} On an unsafe name, or when the file already exists.
 */
export async function scaffold(options: ScaffoldOptions): Promise<ScaffoldResult> {
  const { kind, name } = options;
  if (!SAFE_NAME.test(name)) {
    throw new ScaffoldError(
      `invalid ${kind} name "${name}": use lowercase letters, digits and "-", starting with a letter or digit`,
      true,
    );
  }
  const scope = options.scope ?? "project";
  const dir = scaffoldDir(
    kind,
    scope,
    options.cwd ?? process.cwd(),
    options.home ?? join(homedir(), ".arcturn"),
  );
  const file = join(dir, `${name}.md`);
  // Defense in depth: SAFE_NAME already forecloses traversal by charset, but a
  // containment check costs nothing and does not depend on a regex staying
  // right forever.
  const root = resolve(dir);
  if (!resolve(file).startsWith(root + sep)) {
    throw new ScaffoldError(`"${name}" resolves outside ${dir}`, true);
  }

  await mkdir(dir, { recursive: true });
  try {
    // "wx" is the refusal: exclusive create, so an existing file is an EEXIST
    // from the kernel rather than a stat-then-write race that could still lose
    // someone's work between the two calls.
    await writeFile(file, TEMPLATES[kind](name), { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ScaffoldError(`${file} already exists; nothing was written`);
    }
    throw error;
  }
  return { kind, name, scope, file };
}

/* Top-level `arcturn new` --------------------------------------------------------- */

/** Writes one line of output, mirroring `process.stdout.write`. */
export type ScaffoldWriter = (text: string) => void;

/** Options for {@link runNewCommand}. */
export interface RunNewCommandOptions {
  /** Arguments after `arcturn new`, e.g. `["agent", "reviewer", "--user"]`. */
  argv: readonly string[];
  /** Project working directory. Defaults to `process.cwd()`. */
  cwd?: string;
  /** Arcturn user directory. Pass `paths.home` to honor `ARCTURN_HOME`; defaults to `~/.arcturn`. */
  home?: string;
  stdout?: ScaffoldWriter;
  stderr?: ScaffoldWriter;
}

const NEW_USAGE = `usage: arcturn new <${SCAFFOLD_KINDS.join("|")}> <name> [--user]`;

/**
 * `arcturn new skill|agent|workflow <name> [--user]`.
 *
 * Exit code `0` on success, `1` when the file already exists, `2` on a usage
 * error (an unknown kind, a missing or unsafe name, an unknown flag).
 *
 * @param options - See {@link RunNewCommandOptions}.
 */
export async function runNewCommand(options: RunNewCommandOptions): Promise<number> {
  const stdout = options.stdout ?? ((text: string) => process.stdout.write(`${text}\n`));
  const stderr = options.stderr ?? ((text: string) => process.stderr.write(`${text}\n`));

  let kind: ScaffoldKind | undefined;
  let name: string | undefined;
  let scope: ScaffoldScope = "project";
  for (const token of options.argv) {
    if (token === "--user") {
      scope = "user";
    } else if (token === "--project") {
      scope = "project";
    } else if (token.startsWith("-") && token !== "-") {
      stderr(`arcturn: unknown flag "${token}"\n${NEW_USAGE}`);
      return 2;
    } else if (kind === undefined) {
      if (!isScaffoldKind(token)) {
        stderr(
          `arcturn: unknown kind "${token}". Expected one of: ${SCAFFOLD_KINDS.join(", ")}\n${NEW_USAGE}`,
        );
        return 2;
      }
      kind = token;
    } else if (name === undefined) {
      name = token;
    } else {
      stderr(`arcturn: unexpected argument "${token}"\n${NEW_USAGE}`);
      return 2;
    }
  }
  if (kind === undefined || name === undefined) {
    stderr(`arcturn: ${NEW_USAGE}`);
    return 2;
  }

  try {
    const result = await scaffold({
      kind,
      name,
      scope,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.home === undefined ? {} : { home: options.home }),
    });
    stdout(`Created ${result.kind} "${result.name}" at ${result.file}`);
    stdout(NEXT_STEPS[result.kind](result.name));
    return 0;
  } catch (error) {
    if (error instanceof ScaffoldError) {
      stderr(`arcturn: ${error.message}`);
      return error.usage ? 2 : 1;
    }
    throw error;
  }
}
