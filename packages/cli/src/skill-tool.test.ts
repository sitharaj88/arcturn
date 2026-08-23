import { describe, expect, it, vi } from "vitest";
import { createSkillTool, DEFAULT_SKILL_TOOL_MAX_BODY_CHARS } from "./skill-tool.js";
import type { Skill } from "./skills.js";

/** Build a minimal in-memory {@link Skill} for tests, without touching disk. */
function fakeSkill(overrides: Partial<Skill> & { name: string }): Skill {
  return {
    description: "",
    source: `/fake/${overrides.name}.md`,
    buildPrompt: (args: string) => `body for ${overrides.name} (${args})`,
    ...overrides,
  };
}

function ctx(signal: AbortSignal = new AbortController().signal) {
  return {
    cwd: "/work",
    signal,
    requestPermission: vi.fn(),
    onUpdate: vi.fn(),
    sessionId: "session-1",
    toolCallId: "call-1",
  };
}

describe("createSkillTool", () => {
  it("names the tool skill and requires name in its parameters", () => {
    const tool = createSkillTool({ registry: () => [] });
    expect(tool.definition.name).toBe("skill");
    expect(tool.definition.parameters).toMatchObject({ required: ["name"] });
  });

  it("embeds one line per described skill in the description, sorted by name", () => {
    const tool = createSkillTool({
      registry: () => [
        fakeSkill({ name: "zeta", description: "Does zeta things" }),
        fakeSkill({ name: "alpha", description: "Does alpha things" }),
        fakeSkill({ name: "no-desc" }),
      ],
    });
    const description = tool.definition.description;
    const alphaIdx = description.indexOf("alpha — Does alpha things");
    const zetaIdx = description.indexOf("zeta — Does zeta things");
    expect(alphaIdx).toBeGreaterThan(-1);
    expect(zetaIdx).toBeGreaterThan(alphaIdx);
    expect(description).not.toContain("no-desc —");
  });

  it("says so when no skill has a description", () => {
    const tool = createSkillTool({ registry: () => [fakeSkill({ name: "no-desc" })] });
    expect(tool.definition.description).toContain("No skills currently have a description");
  });

  it("regenerates the description lazily from the registry on each access", () => {
    let skills: Skill[] = [fakeSkill({ name: "first", description: "First skill" })];
    const tool = createSkillTool({ registry: () => skills });
    expect(tool.definition.description).toContain("first — First skill");
    expect(tool.definition.description).not.toContain("second");

    skills = [
      fakeSkill({ name: "first", description: "First skill" }),
      fakeSkill({ name: "second", description: "Second skill" }),
    ];
    expect(tool.definition.description).toContain("second — Second skill");
  });

  it("returns the substituted body of a known skill", async () => {
    const skill = fakeSkill({ name: "review", description: "Review a diff" });
    const tool = createSkillTool({ registry: () => [skill] });
    const result = await tool.execute({ name: "review", args: "packages/cli" }, ctx());
    expect(result.isError).toBeUndefined();
    expect(result.content[0]).toMatchObject({
      type: "text",
      text: "body for review (packages/cli)",
    });
    expect(result.details).toEqual({
      skill: "review",
      chars: "body for review (packages/cli)".length,
    });
  });

  it("defaults args to an empty string when omitted", async () => {
    const skill = fakeSkill({ name: "review", description: "Review a diff" });
    const tool = createSkillTool({ registry: () => [skill] });
    const result = await tool.execute({ name: "review" }, ctx());
    expect(result.content[0]).toMatchObject({ text: "body for review ()" });
  });

  it("truncates an oversized body with a trailing note", async () => {
    const longBody = "x".repeat(100);
    const skill = fakeSkill({
      name: "long",
      description: "A long skill",
      buildPrompt: () => longBody,
    });
    const tool = createSkillTool({ registry: () => [skill], maxBodyChars: 10 });
    const result = await tool.execute({ name: "long" }, ctx());
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text.startsWith("x".repeat(10))).toBe(true);
    expect(text).toContain("truncated");
    expect(text).toContain("100 chars");
    expect(result.details).toEqual({ skill: "long", chars: text.length });
  });

  it("uses the default body cap when none is given", async () => {
    const skill = fakeSkill({
      name: "huge",
      description: "Huge",
      buildPrompt: () => "y".repeat(DEFAULT_SKILL_TOOL_MAX_BODY_CHARS + 50),
    });
    const tool = createSkillTool({ registry: () => [skill] });
    const result = await tool.execute({ name: "huge" }, ctx());
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("truncated");
    expect(text.length).toBeLessThan(DEFAULT_SKILL_TOOL_MAX_BODY_CHARS + 100);
  });

  it("rejects a missing or blank name", async () => {
    const tool = createSkillTool({ registry: () => [] });
    const missing = await tool.execute({}, ctx());
    expect(missing.isError).toBe(true);
    const blank = await tool.execute({ name: "   " }, ctx());
    expect(blank.isError).toBe(true);
  });

  it("reports an unknown skill with no suggestions when the registry is empty", async () => {
    const tool = createSkillTool({ registry: () => [] });
    const result = await tool.execute({ name: "anything" }, ctx());
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain('Unknown skill "anything"');
    expect(text).toContain("No skills are currently loaded");
  });

  it("suggests substring matches over unrelated names", async () => {
    const tool = createSkillTool({
      registry: () => [
        fakeSkill({ name: "review", description: "Review a diff" }),
        fakeSkill({ name: "release", description: "Cut a release" }),
        fakeSkill({ name: "zzz-unrelated" }),
      ],
    });
    const result = await tool.execute({ name: "revie" }, ctx());
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("Did you mean:");
    expect(text).toContain("review");
    expect(text.indexOf("review")).toBeLessThan(
      text.includes("zzz-unrelated") ? text.indexOf("zzz-unrelated") : Number.POSITIVE_INFINITY,
    );
  });

  it("suggests the closest edit-distance name when nothing substring-matches", async () => {
    const tool = createSkillTool({
      registry: () => [
        fakeSkill({ name: "deploy", description: "Deploy the app" }),
        fakeSkill({ name: "completely-different" }),
      ],
    });
    const result = await tool.execute({ name: "deplyo" }, ctx());
    expect(result.isError).toBe(true);
    const text = (result.content[0] as { type: "text"; text: string }).text;
    expect(text).toContain("deploy");
  });

  it("returns an aborted result when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const tool = createSkillTool({ registry: () => [fakeSkill({ name: "review" })] });
    const result = await tool.execute({ name: "review" }, ctx(controller.signal));
    expect(result.isError).toBe(true);
    expect((result.content[0] as { type: "text"; text: string }).text).toContain("Aborted");
  });

  it("passes the execution context's cwd through to buildPrompt", async () => {
    const buildPrompt = vi.fn().mockReturnValue("ok");
    const skill = fakeSkill({ name: "cwd-check", buildPrompt });
    const tool = createSkillTool({ registry: () => [skill] });
    await tool.execute({ name: "cwd-check", args: "foo" }, ctx());
    expect(buildPrompt).toHaveBeenCalledWith("foo", "/work");
  });
});
