import { ColorLevel, setColorLevel, stripAnsi } from "@arcturn/tui";
import type { PermissionRequest } from "@arcturn/types";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createChoice,
  permissionDialog,
  planDialog,
  selectDialog,
  suggestRule,
} from "./dialogs.js";

beforeAll(() => {
  setColorLevel(ColorLevel.None);
});

function request(overrides: Partial<PermissionRequest> = {}): Omit<PermissionRequest, "id"> {
  return {
    toolName: "bash",
    toolCallId: "c1",
    subject: "git status --short",
    description: "bash: git status --short",
    ...overrides,
  };
}

describe("suggestRule", () => {
  it("widens a bash subject to a command prefix", () => {
    expect(suggestRule(request())).toEqual({
      tool: "bash",
      specifier: "git *",
      action: "allow",
    });
  });

  it("prefers the prefix even when the runtime suggested an exact command", () => {
    expect(
      suggestRule(
        request({
          suggestedRule: { tool: "bash", specifier: "git status --short", action: "allow" },
        }),
      ).specifier,
    ).toBe("git *");
  });

  it("uses the runtime suggestion for other tools", () => {
    expect(
      suggestRule(
        request({
          toolName: "write",
          subject: "/a/b.ts",
          suggestedRule: { tool: "write", specifier: "src/**", action: "allow" },
        }),
      ),
    ).toEqual({ tool: "write", specifier: "src/**", action: "allow" });
  });

  it("falls back to a tool-wide rule when there is no subject", () => {
    expect(suggestRule(request({ toolName: "fetch", subject: "" }))).toEqual({
      tool: "fetch",
      action: "allow",
    });
  });

  it("uses the subject verbatim for a non-bash tool with no suggestion", () => {
    expect(suggestRule(request({ toolName: "edit", subject: "/a/b.ts" }))).toEqual({
      tool: "edit",
      specifier: "/a/b.ts",
      action: "allow",
    });
  });
});

describe("createChoice", () => {
  it("resolves with the confirmed row", async () => {
    const choice = createChoice([
      { value: "a", data: 1 },
      { value: "b", data: 2 },
    ]);
    choice.list.selectNext();
    choice.list.confirm();
    expect(await choice.result).toBe(2);
  });

  it("resolves with undefined when cancelled", async () => {
    const choice = createChoice([{ value: "a", data: 1 }]);
    choice.list.handleInput({
      name: "escape",
      ctrl: false,
      alt: false,
      shift: false,
      meta: false,
      sequence: "",
    });
    expect(await choice.result).toBeUndefined();
  });
});

describe("permissionDialog", () => {
  it("shows the tool, the subject and three choices", () => {
    const dialog = permissionDialog(request(), 80);
    const rendered = stripAnsi(dialog.component.render(70).join("\n"));
    expect(rendered).toContain("Permission required");
    expect(rendered).toContain("bash");
    expect(rendered).toContain("git status --short");
    expect(rendered).toContain("Allow once");
    expect(rendered).toContain("Allow always: bash git *");
    expect(rendered).toContain("Deny");
  });

  it("attributes a delegated request to the role and step that raised it", () => {
    // A `/workflow` org run farms one prompt-raising session out to several
    // roles in sequence. Without this line the operator cannot tell which of
    // them is asking, and seven roles asking in turn reads as one endless
    // stream — which is what "yolo is being ignored" actually feels like.
    const dialog = permissionDialog(request({ origin: "@qa-functional \u00b7 step 3" }), 80);
    const rendered = stripAnsi(dialog.component.render(70).join("\n"));
    expect(rendered).toContain("@qa-functional \u00b7 step 3");
    // …without displacing anything the dialog already showed
    expect(rendered).toContain("bash");
    expect(rendered).toContain("git status --short");
    expect(rendered).toContain("Allow once");
  });

  it("adds the attribution line only when something delegated the request", () => {
    // The main agent's own prompts must look EXACTLY as they did before
    // attribution existed: same lines, in the same order, nothing extra.
    const plain = stripAnsi(permissionDialog(request(), 80).component.render(70).join("\n"));
    const attributed = stripAnsi(
      permissionDialog(request({ origin: "@qa-functional \u00b7 step 3" }), 80)
        .component.render(70)
        .join("\n"),
    );
    expect(plain).not.toContain("@qa-functional");
    expect(plain.split("\n")).toHaveLength(attributed.split("\n").length - 1);
  });
});

describe("planDialog", () => {
  it("renders the plan markdown above the choices", () => {
    const dialog = planDialog("# Step one\n\nDo the thing.");
    const rendered = stripAnsi(dialog.component.render(70).join("\n"));
    expect(rendered).toContain("Plan ready");
    expect(rendered).toContain("Step one");
    expect(rendered).toContain("Do the thing.");
    expect(rendered).toContain("Approve");
    expect(rendered).toContain("Keep planning");
  });
});

describe("selectDialog", () => {
  it("titles the box and shows the filter hint when filterable", () => {
    const rendered = stripAnsi(
      selectDialog("Pick one", [{ value: "a", data: "a" }], { filterable: true })
        .component.render(60)
        .join("\n"),
    );
    expect(rendered).toContain("Pick one");
    expect(rendered).toContain("type to filter");
  });
});

describe("select initialValue", () => {
  it("opens the picker on the given row instead of the first", () => {
    const { list } = createChoice(
      [
        { value: "dark", data: "dark" },
        { value: "light", data: "light" },
      ],
      { initialValue: "light" },
    );
    expect(list.selected?.value).toBe("light");
  });

  it("falls back to the first row for an unknown value", () => {
    const { list } = createChoice(
      [
        { value: "dark", data: "dark" },
        { value: "light", data: "light" },
      ],
      { initialValue: "solarized" },
    );
    expect(list.selected?.value).toBe("dark");
  });
});
