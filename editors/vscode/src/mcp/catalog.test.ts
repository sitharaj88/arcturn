/**
 * Turning what a server publishes into rows a person can choose.
 *
 * The engine already sanitized every description on the way out. What is left
 * to establish here is the second half of that rule and the judgements around
 * it: that a row is built from plain strings, that a template's required
 * arguments are collected before the round trip rather than after the server
 * refuses, and that a resource nobody could attach is not offered as though
 * they could.
 */

import { describe, expect, it } from "vitest";
import {
  argumentsToPrompt,
  isAttachable,
  missingRequired,
  parsePromptCommand,
  promptRow,
  promptText,
  resourceRow,
} from "./catalog.js";

describe("naming a resource in a list", () => {
  it("uses the server's name, and keeps the uri visible beside it", () => {
    expect(
      resourceRow({
        server: "figma",
        uri: "figma://file/abc/frame/1",
        name: "Checkout frame",
        description: "The checkout screen.",
      }),
    ).toEqual({
      label: "Checkout frame",
      description: "figma://file/abc/frame/1",
      detail: "The checkout screen.",
    });
  });

  it("falls back to the uri, without repeating it in both columns", () => {
    // A label and a description holding the same string is a row that wastes
    // half its width saying one thing twice.
    const row = resourceRow({ server: "db", uri: "db://schema/public" });
    expect(row.label).toBe("db://schema/public");
    expect(row.description).toBe("");
  });
});

describe("naming a prompt template", () => {
  it("prefixes the server, because a prompt name is unique only per server", () => {
    // Two servers publishing `review` is not a conflict to resolve silently:
    // one row winning would hide the other.
    const row = promptRow({ server: "linear", name: "triage", description: "Triage an issue." });
    expect(row.label).toBe("linear:triage");
    expect(row.detail).toBe("Triage an issue.");
  });

  it("says what it will ask for before it asks", () => {
    const row = promptRow({
      server: "linear",
      name: "triage",
      arguments: [
        { name: "issueId", required: true },
        { name: "tone", required: false },
      ],
    });
    expect(row.description).toBe("2 arguments, 1 required");
  });

  it("says so plainly when it needs nothing", () => {
    expect(promptRow({ server: "x", name: "y" }).description).toBe("no arguments");
  });
});

describe("collecting a template's arguments", () => {
  const prompt = {
    server: "linear",
    name: "triage",
    arguments: [
      { name: "issueId", description: "The issue id.", required: true },
      { name: "tone", description: "How to write it.", required: false },
      { name: "extra" },
    ],
  };

  it("asks only for what is required, by default", () => {
    // A form demanding every optional argument is a form nobody finishes.
    expect(argumentsToPrompt(prompt).map((argument) => argument.name)).toEqual(["issueId"]);
  });

  it("asks for the rest when the caller opts in", () => {
    expect(argumentsToPrompt(prompt, { includeOptional: true }).map((a) => a.name)).toEqual([
      "issueId",
      "tone",
      "extra",
    ]);
  });

  it("treats an argument with no `required` flag as optional", () => {
    // MCP makes the field optional, and absent is not the same as `true`.
    // Guessing `required` would block a form on a field the server never
    // insisted on.
    expect(argumentsToPrompt(prompt).map((a) => a.name)).not.toContain("extra");
  });

  it("names what is still missing, before the round trip", () => {
    // The server would refuse this too, in its own prose. Catching it here
    // means the message names the field rather than quoting a remote error.
    expect(missingRequired(prompt, {})).toEqual(["issueId"]);
    expect(missingRequired(prompt, { issueId: "" })).toEqual(["issueId"]);
    expect(missingRequired(prompt, { issueId: "ENG-1" })).toEqual([]);
  });

  it("asks nothing of a template that declares nothing", () => {
    expect(argumentsToPrompt({ server: "x", name: "y" })).toEqual([]);
    expect(missingRequired({ server: "x", name: "y" }, {})).toEqual([]);
  });
});

describe("what lands in the composer", () => {
  it("keeps the material and drops the roles", () => {
    // A template's messages are a conversation the *server* imagined.
    // Replaying its `assistant` turns as though Arcturn had said them would be
    // putting words in the agent's mouth.
    expect(
      promptText([
        { role: "user", text: "Triage ENG-1." },
        { role: "assistant", text: "Here is how I would start." },
      ]),
    ).toBe("Triage ENG-1.\n\nHere is how I would start.");
  });

  it("drops empty messages rather than leaving gaps", () => {
    expect(
      promptText([
        { role: "user", text: "a" },
        { role: "user", text: "  " },
      ]),
    ).toBe("a");
  });
});

describe("reading a /server:name command", () => {
  it("splits the two halves", () => {
    expect(parsePromptCommand("linear:triage")).toEqual({ server: "linear", prompt: "triage" });
  });

  it("refuses a name that is not one", () => {
    // A skill called `review` must not be mistaken for a prompt, and neither
    // half may be empty — `:x` and `x:` name nothing.
    expect(parsePromptCommand("review")).toBeUndefined();
    expect(parsePromptCommand(":triage")).toBeUndefined();
    expect(parsePromptCommand("linear:")).toBeUndefined();
  });

  it("splits on the first colon, so a uri-shaped prompt name survives", () => {
    expect(parsePromptCommand("linear:issue:triage")).toEqual({
      server: "linear",
      prompt: "issue:triage",
    });
  });
});

describe("deciding what can be attached", () => {
  it("takes text and the json and xml families", () => {
    expect(isAttachable({ server: "s", uri: "u", mimeType: "text/markdown" })).toBe(true);
    expect(isAttachable({ server: "s", uri: "u", mimeType: "application/json" })).toBe(true);
    expect(isAttachable({ server: "s", uri: "u", mimeType: "application/ld+json" })).toBe(true);
    expect(isAttachable({ server: "s", uri: "u", mimeType: "image/svg+xml" })).toBe(true);
  });

  it("refuses what would arrive as a placeholder", () => {
    // The engine injects "(binary content, not included)" for these. A row
    // that leads there is worse than one that says up front it cannot be sent.
    expect(isAttachable({ server: "s", uri: "u", mimeType: "image/png" })).toBe(false);
    expect(isAttachable({ server: "s", uri: "u", mimeType: "application/pdf" })).toBe(false);
  });

  it("treats an undeclared type as attachable", () => {
    // A server that declared nothing is far likelier to be serving text than
    // a PNG it forgot to label, and the cost of being wrong is one bad
    // attachment rather than a resource nobody can reach.
    expect(isAttachable({ server: "s", uri: "u" })).toBe(true);
    expect(isAttachable({ server: "s", uri: "u", mimeType: "" })).toBe(true);
  });
});
