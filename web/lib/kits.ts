/**
 * The kit sources themselves — read at build time, beside `registry/*.json`.
 *
 * The registry carries a *disclosure*: names, lanes, stage counts, one line
 * each. That is the right shape for "what would land on my machine" and the
 * wrong shape for "what does this actually do", which is the question somebody
 * decides on. The answer to that is the file itself: a skill is a prompt, and
 * the prompt is the whole specification.
 *
 * First-party entries point into this repository, so the file is on disk at
 * export time and the page can show the real thing rather than a summary of
 * it. A third-party entry's tree is not here — {@link kitItem} returns
 * `undefined` and the page falls back to the disclosure, which is the same gap
 * `registry/README.md` states about the cross-check.
 *
 * No `@/` imports and no React: `web/scripts/hub.test.ts` loads this module
 * directly from the monorepo suite, which resolves neither.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/** One skill or workflow, as its own file defines it. */
export interface KitItem {
  /** Directory name under `kits/`. */
  kit: string;
  /** File-declared name, which is what the command uses. */
  name: string;
  /** `description:` from the frontmatter, or "" when it declares none. */
  description: string;
  /** Everything after the frontmatter — the prompt, verbatim. */
  body: string;
  /** Frontmatter keys other than name and description, in file order. */
  meta: { key: string; value: string }[];
  /** Sibling reference files a folder skill ships, by filename. */
  references: string[];
}

let cachedRoot: string | null = null;

/**
 * Where `kits/` lives, found the same way {@link registryDir} finds its own —
 * `next build` runs from `web/`, a test from the repository root.
 */
export function kitsDir(): string {
  if (cachedRoot) return cachedRoot;
  const candidates = [path.join(process.cwd(), "kits"), path.join(process.cwd(), "..", "kits")];
  for (const dir of candidates) {
    if (existsSync(dir) && statSync(dir).isDirectory()) {
      cachedRoot = dir;
      return dir;
    }
  }
  throw new Error(`kits/ not found from ${process.cwd()} (looked in: ${candidates.join(", ")})`);
}

/**
 * Split `---` frontmatter from the body.
 *
 * Deliberately not a YAML parser. The frontmatter here is flat `key: value`
 * lines, and pulling a parser in to read them would be a dependency whose
 * failure modes are larger than the thing it reads. A line that does not split
 * on a colon is skipped rather than guessed at.
 */
function splitFrontmatter(source: string): {
  meta: { key: string; value: string }[];
  body: string;
} {
  const text = source.replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) return { meta: [], body: text.trim() };
  const end = text.indexOf("\n---", 4);
  if (end === -1) return { meta: [], body: text.trim() };

  const meta: { key: string; value: string }[] = [];
  for (const line of text.slice(4, end).split("\n")) {
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const at = line.indexOf(":");
    if (at === -1) continue;
    meta.push({ key: line.slice(0, at).trim(), value: line.slice(at + 1).trim() });
  }
  return { meta, body: text.slice(end + 4).trim() };
}

function readItem(kit: string, file: string, references: string[]): KitItem | undefined {
  let source: string;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const { meta, body } = splitFrontmatter(source);
  const named = meta.find((row) => row.key === "name")?.value;
  return {
    kit,
    name: named ?? path.basename(file, ".md"),
    description: meta.find((row) => row.key === "description")?.value ?? "",
    body,
    meta: meta.filter((row) => row.key !== "name" && row.key !== "description"),
    references,
  };
}

/**
 * One skill or workflow by name, or `undefined` when the tree does not have it.
 *
 * A skill is either `<name>.md` or the folder form `<name>/SKILL.md`; the
 * folder form also ships sibling reference files, which are listed because
 * they are part of what the command reads and a reader deciding to install
 * should see that they exist.
 */
export function kitItem(
  kit: string,
  kind: "skills" | "workflows",
  name: string,
): KitItem | undefined {
  let root: string;
  try {
    root = kitsDir();
  } catch {
    return undefined;
  }
  // Names come from the registry and from generateStaticParams, never from a
  // request — but this joins a path, so anything that could climb out of the
  // kit is refused rather than trusted.
  if (!/^[a-z0-9][a-z0-9-]*$/i.test(kit) || !/^[a-z0-9][a-z0-9-]*$/i.test(name)) return undefined;

  const flat = path.join(root, kit, kind, `${name}.md`);
  if (existsSync(flat)) return readItem(kit, flat, []);

  const folder = path.join(root, kit, kind, name);
  const inFolder = path.join(folder, "SKILL.md");
  if (existsSync(inFolder)) {
    const references = readdirSync(folder)
      .filter((entry) => entry.endsWith(".md") && entry !== "SKILL.md")
      .sort();
    return readItem(kit, inFolder, references);
  }
  return undefined;
}

/**
 * The numbered stages of a workflow body, as the pipeline declares them.
 *
 * A stage is a top-level `N.` line; a `-` beneath one is a branch that runs
 * beside its siblings. Read from the file rather than from the registry's
 * stage *count*, so the page shows what each stage actually dispatches and to
 * which role.
 */
export interface KitStage {
  number: number;
  /** The step text, with any leading `@role` kept — it is the dispatch. */
  steps: string[];
}

/**
 * The prose a workflow file opens with, before its first numbered stage.
 *
 * A pipeline file is two documents in one: an argument for why the stages are
 * shaped this way, and the stages. The page shows the stages structurally —
 * numbered, with each dispatch's role as a chip — so rendering the whole file
 * underneath prints every stage a second time, which is how a page ends up
 * saying the same thing twice in two formats and looking like a mistake.
 */
export function workflowPreamble(body: string): string {
  const lines = body.split("\n");
  const first = lines.findIndex((line) => /^\d+\.\s+/.test(line));
  return (first === -1 ? lines : lines.slice(0, first)).join("\n").trim();
}

export function workflowStages(body: string): KitStage[] {
  const stages: KitStage[] = [];
  let open: KitStage | null = null;
  for (const raw of body.split("\n")) {
    const numbered = /^(\d+)\.\s+(.*)$/.exec(raw);
    if (numbered) {
      open = { number: Number(numbered[1]), steps: [numbered[2] ?? ""] };
      stages.push(open);
      continue;
    }
    const branch = /^\s+-\s+(.*)$/.exec(raw);
    if (branch && open) {
      // The first line of a stage that only introduces its branches is a
      // heading for them, not a step; drop it once a real branch arrives.
      if (open.steps.length === 1 && !open.steps[0]?.startsWith("@")) open.steps = [];
      open.steps.push(branch[1] ?? "");
      continue;
    }
    if (raw.trim() === "") open = null;
  }
  return stages;
}
