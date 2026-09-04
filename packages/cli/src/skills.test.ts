import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadSkills } from "./skills.js";

/** Build a temp directory populated with the given relative files. */
async function skillsRoot(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "arcturn-cli-skills-"));
  for (const [name, source] of Object.entries(files)) {
    const path = join(dir, name);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, source, "utf8");
  }
  return dir;
}

describe("loadSkills", () => {
  it("is silently fine when a root does not exist", async () => {
    const warnings: string[] = [];
    const skills = await loadSkills([join(tmpdir(), "arcturn-skills-missing-root-xyz")], warnings);
    expect(skills).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it("loads a plain <name>.md command with full frontmatter", async () => {
    const root = await skillsRoot({
      "review.md": [
        "---",
        "description: Review a diff",
        "name: review",
        "---",
        "Please review: $ARGUMENTS",
      ].join("\n"),
    });
    const warnings: string[] = [];
    const skills = await loadSkills([root], warnings);
    expect(warnings).toEqual([]);
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({
      name: "review",
      description: "Review a diff",
      source: join(root, "review.md"),
    });
    expect(skills[0]?.buildPrompt("the PR", "/work")).toBe("Please review: the PR");
  });

  it("derives the name from the filename, stripping disallowed characters, when frontmatter omits it", async () => {
    const root = await skillsRoot({
      "My Cool Command!.md": "Hello there.",
    });
    const warnings: string[] = [];
    const skills = await loadSkills([root], warnings);
    expect(warnings).toEqual([]);
    expect(skills).toHaveLength(1);
    // spaces and "!" are stripped, case is lowered
    expect(skills[0]?.name).toBe("mycoolcommand");
    expect(skills[0]?.description).toBe("");
  });

  it("parses partial frontmatter (description only, or none at all)", async () => {
    const root = await skillsRoot({
      "desc-only.md": ["---", "description: Just a description", "---", "Body text."].join("\n"),
      "no-frontmatter.md": "Just a body, no fences at all.",
    });
    const warnings: string[] = [];
    const skills = await loadSkills([root], warnings);
    expect(warnings).toEqual([]);
    const byName = new Map(skills.map((skill) => [skill.name, skill]));
    expect(byName.get("desc-only")?.description).toBe("Just a description");
    expect(byName.get("desc-only")?.buildPrompt("", "/x")).toBe("Body text.");
    expect(byName.get("no-frontmatter")?.description).toBe("");
    expect(byName.get("no-frontmatter")?.buildPrompt("", "/x")).toBe(
      "Just a body, no fences at all.",
    );
  });

  it("loads a <name>/SKILL.md folder and substitutes $SKILL_DIR", async () => {
    const root = await skillsRoot({
      "mytool/SKILL.md": [
        "---",
        "description: A folder skill",
        "---",
        "See assets in $SKILL_DIR/assets and args: $ARGUMENTS",
      ].join("\n"),
      "mytool/assets/notes.txt": "unused",
    });
    const warnings: string[] = [];
    const skills = await loadSkills([root], warnings);
    expect(warnings).toEqual([]);
    expect(skills).toHaveLength(1);
    const skill = skills[0];
    expect(skill?.name).toBe("mytool");
    expect(skill?.source).toBe(join(root, "mytool", "SKILL.md"));
    const prompt = skill?.buildPrompt("hi", "/cwd");
    expect(prompt).toBe(`See assets in ${join(root, "mytool")}/assets and args: hi`);
  });

  it("substitutes $ARGUMENTS, positional $1.. with quoted args respected, and $CWD", async () => {
    const root = await skillsRoot({
      "cmd.md": "all=[$ARGUMENTS] first=[$1] second=[$2] third=[$3] cwd=[$CWD]",
    });
    const warnings: string[] = [];
    const skills = await loadSkills([root], warnings);
    const skill = skills[0];
    expect(skill?.buildPrompt('foo "bar baz" qux', "/some/dir")).toBe(
      'all=[foo "bar baz" qux] first=[foo] second=[bar baz] third=[qux] cwd=[/some/dir]',
    );
  });

  it("never re-scans substituted text for further tokens", async () => {
    // Substitution is one pass, deliberately. Arguments are caller text — on
    // the serve path, remote caller text — and a second pass would let them
    // name tokens of their own: `$SKILL_DIR` typed as an argument would expand
    // into the skill folder's real absolute path, handing a caller a path
    // outside the workspace to walk from. A template's own tokens expand; what
    // they expand *to* is final.
    const root = await skillsRoot({
      "tool/SKILL.md": "dir=[$SKILL_DIR] args=[$ARGUMENTS] first=[$1]",
    });
    const warnings: string[] = [];
    const skills = await loadSkills([root], warnings);
    const skill = skills[0];
    const prompt = skill?.buildPrompt("$SKILL_DIR/../../etc/passwd $CWD", "/some/dir");
    expect(prompt).toBe(
      `dir=[${join(root, "tool")}] args=[$SKILL_DIR/../../etc/passwd $CWD] ` +
        "first=[$SKILL_DIR/../../etc/passwd]",
    );
    expect(prompt).not.toContain(`${join(root, "tool")}/../../etc/passwd`);
  });

  it("substitutes an empty string for a missing positional argument", async () => {
    const root = await skillsRoot({ "cmd.md": "one=[$1] two=[$2]" });
    const warnings: string[] = [];
    const skills = await loadSkills([root], warnings);
    expect(skills[0]?.buildPrompt("only", "/x")).toBe("one=[only] two=[]");
  });

  it("lets a later root win a name collision and warns naming both files", async () => {
    const userRoot = await skillsRoot({ "deploy.md": "user body" });
    const projectRoot = await skillsRoot({ "deploy.md": "project body" });
    const warnings: string[] = [];
    const skills = await loadSkills([userRoot, projectRoot], warnings);
    expect(skills).toHaveLength(1);
    expect(skills[0]?.buildPrompt("", "/x")).toBe("project body");
    expect(skills[0]?.source).toBe(join(projectRoot, "deploy.md"));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(join(projectRoot, "deploy.md"));
    expect(warnings[0]).toContain(join(userRoot, "deploy.md"));
  });

  it("skips a file with an empty body and warns", async () => {
    const root = await skillsRoot({
      "empty.md": ["---", "description: nothing here", "---", "   ", ""].join("\n"),
      "good.md": "Not empty.",
    });
    const warnings: string[] = [];
    const skills = await loadSkills([root], warnings);
    expect(skills.map((skill) => skill.name)).toEqual(["good"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(join(root, "empty.md"));
    expect(warnings[0]).toContain("empty body");
  });

  it("skips an unreadable file (a directory named *.md at the top level) and warns", async () => {
    const root = await skillsRoot({ "good.md": "Fine." });
    // A directory whose name ends in .md is not a candidate at all (only
    // <name>/SKILL.md folders are), so simulate "unreadable" by making
    // SKILL.md itself a directory instead of a file.
    await mkdir(join(root, "broken", "SKILL.md"), { recursive: true });
    const warnings: string[] = [];
    const skills = await loadSkills([root], warnings);
    expect(skills.map((skill) => skill.name)).toEqual(["good"]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(join(root, "broken", "SKILL.md"));
  });

  it("normalizes a frontmatter-provided name the same way as a filename", async () => {
    const root = await skillsRoot({
      "file-name.md": ["---", "name: Custom Name!!", "---", "body"].join("\n"),
    });
    const warnings: string[] = [];
    const skills = await loadSkills([root], warnings);
    expect(skills[0]?.name).toBe("customname");
  });

  it("accepts (and ignores) a skill-synthesis provenance frontmatter without warning or breaking", async () => {
    const root = await skillsRoot({
      "from-a-run/SKILL.md": [
        "---",
        "name: from-a-run",
        "description: Redo what that run did",
        "source-run: run-abc123",
        "generated: 2026-09-04T00:00:00.000Z",
        "---",
        "1. Do the thing: $ARGUMENTS",
      ].join("\n"),
    });
    const warnings: string[] = [];
    const skills = await loadSkills([root], warnings);
    expect(warnings).toEqual([]);
    expect(skills).toHaveLength(1);
    expect(skills[0]).toMatchObject({ name: "from-a-run", description: "Redo what that run did" });
    expect(skills[0]?.buildPrompt("foo", "/cwd")).toBe("1. Do the thing: foo");
  });
});
