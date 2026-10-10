import type { McpElicitationField, McpElicitationRequest } from "@arcturn/mcp";
import { ColorLevel, type Component, createKey, setColorLevel, stripAnsi } from "@arcturn/tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { DialogHandle } from "./dialogs.js";
import { elicitationDialog, parseElicitationText, runElicitationForm } from "./elicitation-form.js";

beforeAll(() => {
  setColorLevel(ColorLevel.None);
});

function request(
  fields: McpElicitationField[],
  message = "Connect your account",
): McpElicitationRequest {
  return { server: "docs", message, fields, signal: new AbortController().signal };
}

const TOKEN: McpElicitationField = {
  name: "token",
  kind: "string",
  required: true,
  title: "API token",
};
const RETRIES: McpElicitationField = {
  name: "retries",
  kind: "number",
  integer: true,
  required: false,
};
const AGREE: McpElicitationField = { name: "agree", kind: "boolean", required: true };
const TIER: McpElicitationField = {
  name: "tier",
  kind: "enum",
  required: true,
  options: [
    { value: "free", label: "Free" },
    { value: "pro", label: "Pro" },
  ],
};

type Step = (component: Component) => void;

const press =
  (...names: string[]): Step =>
  (component) => {
    for (const name of names) component.handleInput?.(createKey(name));
  };

const type =
  (text: string): Step =>
  (component) => {
    for (const char of text) component.handleInput?.(createKey(char));
    component.handleInput?.(createKey("enter"));
  };

/** A `show` that answers each dialog with the next scripted step, recording what was drawn. */
function scripted(steps: Step[]) {
  const screens: string[] = [];
  const show = async <T>(dialog: DialogHandle<T>): Promise<T | undefined> => {
    screens.push(stripAnsi(dialog.component.render(80).join("\n")));
    const step = steps.shift();
    if (!step) throw new Error("dialog shown with no scripted answer");
    step(dialog.component);
    return dialog.result;
  };
  return { show, screens, remaining: () => steps.length };
}

describe("elicitationDialog", () => {
  it("names the server, shows its message and lists the fields asked for", () => {
    const dialog = elicitationDialog(request([TOKEN, RETRIES]), 80);
    const text = stripAnsi(dialog.component.render(80).join("\n"));
    expect(text).toContain("docs");
    expect(text).toContain("Connect your account");
    expect(text).toContain("API token");
    expect(text).toContain("retries");
    expect(text).toMatch(/decline/i);
  });

  it("strips terminal control sequences from the server's text", () => {
    const dialog = elicitationDialog(request([], "hi\u001b[2Jthere\u0007"), 80);
    const text = dialog.component.render(80).join("\n");
    expect(text).not.toContain("\u001b[2J");
    expect(text).not.toContain("\u0007");
  });
});

describe("parseElicitationText", () => {
  it("parses integers and rejects fractions and junk", () => {
    expect(parseElicitationText(RETRIES, "3")).toEqual({ ok: true, value: 3 });
    expect(parseElicitationText(RETRIES, "3.5").ok).toBe(false);
    expect(parseElicitationText(RETRIES, "three").ok).toBe(false);
  });

  it("enforces string bounds", () => {
    const short: McpElicitationField = { name: "s", kind: "string", required: true, maxLength: 3 };
    expect(parseElicitationText(short, "abcd").ok).toBe(false);
    expect(parseElicitationText(short, "abc")).toEqual({ ok: true, value: "abc" });
  });

  it("reads a multi-select as comma-separated options", () => {
    const tags: McpElicitationField = {
      name: "tags",
      kind: "multiEnum",
      required: false,
      options: [
        { value: "a", label: "A" },
        { value: "b", label: "B" },
      ],
    };
    expect(parseElicitationText(tags, "a, b")).toEqual({ ok: true, value: ["a", "b"] });
    expect(parseElicitationText(tags, "a, z").ok).toBe(false);
  });
});

describe("runElicitationForm", () => {
  it("collects every field and accepts", async () => {
    const { show, remaining } = scripted([
      press("enter"), // Respond
      type("tok-123"), // token
      type("4"), // retries
      press("enter"), // agree: first row is Yes
      press("down", "enter"), // tier: Pro
    ]);
    const result = await runElicitationForm(request([TOKEN, RETRIES, AGREE, TIER]), show, {
      width: 80,
    });
    expect(result).toEqual({
      action: "accept",
      content: { token: "tok-123", retries: 4, agree: true, tier: "pro" },
    });
    expect(remaining()).toBe(0);
  });

  it("skips an optional field left empty", async () => {
    const { show } = scripted([press("enter"), type("tok"), press("enter")]);
    const result = await runElicitationForm(request([TOKEN, RETRIES]), show, { width: 80 });
    expect(result).toEqual({ action: "accept", content: { token: "tok" } });
  });

  it("asks again, with the reason, when an answer does not parse", async () => {
    const { show, screens } = scripted([press("enter"), type("tok"), type("lots"), type("2")]);
    const result = await runElicitationForm(request([TOKEN, RETRIES]), show, { width: 80 });
    expect(result).toEqual({ action: "accept", content: { token: "tok", retries: 2 } });
    expect(screens.at(-1)).toContain('"lots" is not a whole number');
  });

  it("declines from the first dialog", async () => {
    const { show } = scripted([press("down", "enter")]);
    expect(await runElicitationForm(request([TOKEN]), show, { width: 80 })).toEqual({
      action: "decline",
    });
  });

  it("cancels on escape, at the first dialog or mid-form", async () => {
    expect(
      await runElicitationForm(request([TOKEN]), scripted([press("escape")]).show, { width: 80 }),
    ).toEqual({ action: "cancel" });
    expect(
      await runElicitationForm(
        request([TOKEN, RETRIES]),
        scripted([press("enter"), press("escape")]).show,
        {
          width: 80,
        },
      ),
    ).toEqual({ action: "cancel" });
  });

  it("accepts a field-less confirmation with empty content", async () => {
    const { show } = scripted([press("enter")]);
    expect(await runElicitationForm(request([]), show, { width: 80 })).toEqual({
      action: "accept",
      content: {},
    });
  });
});
