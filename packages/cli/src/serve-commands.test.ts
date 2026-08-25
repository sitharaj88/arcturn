import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { REMOTE_REACHABLE_BUILT_IN_COMMANDS } from "@arcturn/server";
import { describe, expect, it } from "vitest";
import { createBuiltInCommands } from "./commands.js";
import { expandServedCommand, serveCommandDescriptors } from "./serve-commands.js";
import { loadSkills, type Skill } from "./skills.js";

/** A real skills root with real files — `loadSkills` is half of what is under test. */
async function library(files: Record<string, string>): Promise<readonly Skill[]> {
  const root = await mkdtemp(join(tmpdir(), "arcturn-serve-commands-"));
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(root, name), body, "utf8");
  }
  const warnings: string[] = [];
  return loadSkills([root], warnings);
}

describe("the reachable built-ins are commands the terminal actually has", () => {
  it("names no command createBuiltInCommands() does not define", () => {
    // The third leg of the "two exports, one fact" discipline
    // (`permissions-wire.test.ts` holds the other two). `@arcturn/server`
    // decides *which* built-ins this wire can carry out; it does not get to
    // invent one. A `/delete` listed for `deleteSession` would be a command
    // that exists in the panel and nowhere else, which is exactly the
    // divergence RFC 0004 §0 forbids, pointed the other way.
    const terminal = new Set(createBuiltInCommands().map((command) => command.name));
    for (const command of REMOTE_REACHABLE_BUILT_IN_COMMANDS) {
      expect(terminal).toContain(command.name);
    }
  });
});

describe("serveCommandDescriptors", () => {
  it("lists skills alphabetically, then the built-ins in their fixed order", async () => {
    const skills = await library({ "zeta.md": "z", "alpha.md": "a" });
    const listed = serveCommandDescriptors(skills).map((command) => command.name);
    expect(listed).toEqual([
      "alpha",
      "zeta",
      ...REMOTE_REACHABLE_BUILT_IN_COMMANDS.map((command) => command.name),
    ]);
  });

  it("names the file when a skill set no description, rather than showing a blank row", async () => {
    const skills = await library({ "bare.md": "body" });
    const bare = serveCommandDescriptors(skills).find((command) => command.name === "bare");
    expect(bare?.description).toContain("bare.md");
  });
});

describe("expandServedCommand", () => {
  it("expands a leading /name into the skill's substituted body", async () => {
    const skills = await library({ "review.md": "Review $ARGUMENTS in $CWD." });
    const result = expandServedCommand("/review the diff", skills, "/ws");
    expect(result).toEqual({
      outcome: "expanded",
      name: "review",
      text: "Review the diff in /ws.",
    });
  });

  it("matches the name case-insensitively, as the terminal registry does", async () => {
    const skills = await library({ "review.md": "body" });
    expect(expandServedCommand("/REVIEW", skills, "/ws")).toMatchObject({ outcome: "expanded" });
  });

  it("treats a prompt with no leading slash as prose", async () => {
    const skills = await library({ "review.md": "body" });
    expect(expandServedCommand("please review the diff", skills, "/ws")).toEqual({
      outcome: "notACommand",
    });
  });

  it("treats a /name that is not leading as prose", async () => {
    const skills = await library({ "review.md": "body" });
    expect(expandServedCommand("run /review for me", skills, "/ws")).toEqual({
      outcome: "notACommand",
    });
  });

  it("treats a slash-path as prose, not as a failed command", async () => {
    // The deliberate narrowing against `CommandRegistry.dispatch`: a chat
    // composer is where people send paths, and refusing these would be worse
    // than the typo the refusal exists to catch.
    const skills = await library({ "review.md": "body" });
    for (const prose of [
      "/etc/hosts has the wrong entry",
      "/usr/local/bin is not on PATH",
      "/ leading slash alone",
      "/re:view is not a name",
    ]) {
      expect(expandServedCommand(prose, skills, "/ws")).toEqual({ outcome: "notACommand" });
    }
  });

  it("refuses an unknown name and suggests the nearest one", async () => {
    const skills = await library({ "review.md": "body" });
    const result = expandServedCommand("/reviw the diff", skills, "/ws");
    expect(result.outcome).toBe("refused");
    expect(result.outcome === "refused" && result.reason).toContain("/review");
    expect(result.outcome === "refused" && result.reason).toContain("no turn was spent");
  });

  it("suggests a built-in too, not just skills", async () => {
    const result = expandServedCommand("/modle", [], "/ws");
    expect(result.outcome === "refused" && result.reason).toContain("/model");
  });

  it("refuses a built-in by name and names the verbs that run it", async () => {
    const result = expandServedCommand("/permissions", [], "/ws");
    expect(result.outcome).toBe("refused");
    expect(result.outcome === "refused" && result.reason).toContain("setPermissionMode");
    expect(result.outcome === "refused" && result.reason).toContain("permissionState");
  });

  it("refuses every name it lists that it cannot expand, and expands every one it can", async () => {
    // The invariant RFC 0005 §3 actually asks for: the menu and the behaviour
    // agree. Every listed command either expands or refuses with a reason —
    // none of them quietly reaches the model as literal text.
    const skills = await library({ "review.md": "body", "ship.md": "body" });
    for (const command of serveCommandDescriptors(skills)) {
      const result = expandServedCommand(`/${command.name}`, skills, "/ws");
      expect(result.outcome).toBe(command.kind === "skill" ? "expanded" : "refused");
    }
  });

  it("lets a built-in win a name collision, the way createCommandRegistry does", async () => {
    // In the terminal a skill called `model` is registered second and skipped
    // with a warning, so `/model` opens the picker. Both halves have to agree
    // here too, or the name means one thing in the panel and another in the
    // terminal.
    const skills = await library({ "model.md": "SHADOWED_BODY" });
    expect(serveCommandDescriptors(skills).filter((c) => c.name === "model")).toEqual([
      { name: "model", description: "Switch the model", kind: "builtin" },
    ]);
    const result = expandServedCommand("/model", skills, "/ws");
    expect(result.outcome).toBe("refused");
    expect(result.outcome === "refused" && result.reason).toContain("setModel");
  });

  it("does not mistake an Object prototype key for a built-in", () => {
    // `constructor` clears the `[A-Za-z0-9-]+` shape and would answer truthy to
    // a plain key lookup on the verb map.
    const result = expandServedCommand("/constructor", [], "/ws");
    expect(result.outcome).toBe("refused");
    expect(result.outcome === "refused" && result.reason).toContain(
      "No command named /constructor",
    );
  });

  it("refuses everything when no skills are loaded rather than passing a command through", () => {
    const result = expandServedCommand("/review", [], "/ws");
    expect(result.outcome).toBe("refused");
  });

  it("does not let arguments name substitution tokens of their own", async () => {
    const skills = await library({ "cmd.md": "args=[$ARGUMENTS] cwd=[$CWD]" });
    const result = expandServedCommand("/cmd $CWD", skills, "/secret/home/ws");
    // The template's own $CWD expanded; the caller's did not.
    expect(result).toEqual({
      outcome: "expanded",
      name: "cmd",
      text: "args=[$CWD] cwd=[/secret/home/ws]",
    });
  });
});
