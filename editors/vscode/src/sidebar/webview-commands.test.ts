/**
 * The `/` menu's decisions, driven as functions.
 *
 * `COMMAND_MENU_SOURCE` is the text the webview runs, compiled here so these
 * tests exercise the shipped bytes. The rule under test is RFC 0005 §3's —
 * "no command the panel cannot run" — applied a second time, on the panel's
 * own terms: the engine already refuses to list a command *it* cannot carry
 * out, and `runnableCommands` refuses to show a built-in *this* panel has no
 * surface for.
 */

import { describe, expect, it } from "vitest";
import { COMMAND_MENU_SOURCE, type CommandOption } from "./webview-commands.js";

const api = new Function(
  `${COMMAND_MENU_SOURCE}\nreturn { runnableCommands, orderCommands, filterCommands, commandMeta, commandInsert, builtinAction };`,
)() as {
  runnableCommands: (commands: CommandOption[]) => CommandOption[];
  orderCommands: (commands: CommandOption[]) => CommandOption[];
  filterCommands: (commands: CommandOption[], query: string) => CommandOption[];
  commandMeta: (command: CommandOption) => string;
  commandInsert: (command: CommandOption) => string;
  builtinAction: (command: CommandOption) => string;
};

function skill(name: string, over: Partial<CommandOption> = {}): CommandOption {
  return {
    name,
    description: `Run the ${name} skill`,
    kind: "skill",
    source: `/w/.arcturn/skills/${name}.md`,
    ...over,
  };
}

function builtin(name: string, description = `The ${name} built-in`): CommandOption {
  return { name, description, kind: "builtin" };
}

describe("runnableCommands", () => {
  it("keeps every skill, because a skill is prompt text and the panel can always send that", () => {
    expect(api.runnableCommands([skill("review"), skill("changelog")])).toHaveLength(2);
  });

  it("keeps the built-ins this panel actually has a surface for", () => {
    const kept = api
      .runnableCommands([
        builtin("model"),
        builtin("permissions"),
        builtin("sessions"),
        builtin("clear"),
      ])
      .map((row) => row.name);
    expect(kept).toEqual(["model", "permissions", "sessions", "clear"]);
  });

  it("drops a built-in the panel cannot run, rather than offering a menu row that does nothing", () => {
    // `theme` and `compact` are not `rewind`: `rewind` used to be the example
    // here and stopped being one when `listCheckpoints`/`rewindTo` arrived and
    // the panel grew a picker for them. That is the double filter working —
    // the engine's list grew, this one grew with it — rather than an
    // exception, so the example moved to two the panel still has no surface
    // for.
    expect(api.runnableCommands([builtin("theme"), builtin("compact")])).toEqual([]);
  });

  it("drops `bg` and `org`, which the engine lists and this panel has no surface for", () => {
    // The engine lists both because the wire carries them out — four verbs for
    // `/bg`, three for `/org memory`. This panel has no background-agent view
    // and no memory queue, so it offers neither row rather than offering one
    // that does nothing. That is the double filter doing its job in the
    // direction it was built for: the engine's list grew and this one did not,
    // and the menu stayed honest without anybody editing it. The day the panel
    // grows a surface, `BUILTIN_ACTIONS` gains a line and the rows appear.
    expect(api.runnableCommands([builtin("bg"), builtin("org")])).toEqual([]);
    expect(api.builtinAction(builtin("bg"))).toBe("");
    expect(api.builtinAction(builtin("org"))).toBe("");
  });
});

describe("builtinAction", () => {
  it("names the panel surface each built-in opens", () => {
    expect(api.builtinAction(builtin("model"))).toBe("model");
    expect(api.builtinAction(builtin("permissions"))).toBe("permissions");
    expect(api.builtinAction(builtin("sessions"))).toBe("sessions");
    expect(api.builtinAction(builtin("clear"))).toBe("clear");
  });

  it("has nothing to say about a skill, which is inserted rather than run", () => {
    expect(api.builtinAction(skill("review"))).toBe("");
  });
});

describe("orderCommands", () => {
  it("puts skills first and built-ins after, alphabetically inside each band", () => {
    const ordered = api.orderCommands([
      builtin("sessions"),
      skill("zeta"),
      builtin("clear"),
      skill("alpha"),
    ]);
    expect(ordered.map((row) => row.name)).toEqual(["alpha", "zeta", "clear", "sessions"]);
  });

  it("does not lean on the engine having sorted, so a menu cannot inherit a bad order", () => {
    expect(api.orderCommands([builtin("model"), skill("a")])[0]?.kind).toBe("skill");
  });
});

describe("filterCommands", () => {
  const commands = [skill("review", { description: "Review the diff for bugs" }), builtin("model")];

  it("matches the name", () => {
    expect(api.filterCommands(commands, "rev").map((row) => row.name)).toEqual(["review"]);
  });

  it("matches the description too, so a half-remembered skill is still findable", () => {
    expect(api.filterCommands(commands, "diff").map((row) => row.name)).toEqual(["review"]);
  });

  it("ignores a leading slash, because that is what the user just typed", () => {
    expect(api.filterCommands(commands, "/model").map((row) => row.name)).toEqual(["model"]);
  });

  it("returns everything on an empty query", () => {
    expect(api.filterCommands(commands, "")).toHaveLength(2);
  });

  it("says no rather than guessing", () => {
    expect(api.filterCommands(commands, "nothing-like-this")).toEqual([]);
  });
});

describe("commandMeta", () => {
  it("is the engine's own description", () => {
    expect(api.commandMeta(skill("review", { description: "Review the diff" }))).toContain(
      "Review the diff",
    );
  });

  it("names the file a skill came from, so a repo's command is tellable from your own", () => {
    expect(api.commandMeta(skill("review"))).toContain("review.md");
  });

  it("says something rather than nothing for a skill whose frontmatter set no description", () => {
    expect(api.commandMeta(skill("review", { description: "" }))).not.toBe("");
  });

  it("invents no path for a built-in, which has no file", () => {
    expect(api.commandMeta(builtin("model", "Switch the model"))).toBe("Switch the model");
  });
});

describe("commandInsert", () => {
  it("inserts the command and a space, ready for an argument", () => {
    expect(api.commandInsert(skill("review"))).toBe("/review ");
  });
});
