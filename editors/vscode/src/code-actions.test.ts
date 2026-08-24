import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDiagnosticFixProvider,
  FIX_COMMAND,
  registerDiagnosticFixProvider,
} from "./code-actions.js";
import { fake, resetFake } from "./test-vscode.js";

vi.mock("vscode", async () => (await import("./test-vscode.js")).createFakeVscode());

const document = {
  uri: { fsPath: "/work/repo/src/a.ts", toString: () => "file:///work/repo/src/a.ts" },
};
const range = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };

beforeEach(() => {
  resetFake();
});

describe("createDiagnosticFixProvider", () => {
  it("offers one Fix with Arcturn per diagnostic, carrying the engine's own words", () => {
    const provider = createDiagnosticFixProvider();
    const diagnostics = [
      { message: "Type 'A' is not assignable to type 'B'.", range },
      { message: "'x' is declared but never read.", range },
    ];

    const actions = provider.provideCodeActions(
      document as never,
      range as never,
      { diagnostics, only: undefined, triggerKind: 1 } as never,
      {} as never,
    ) as { title: string; command?: { command: string; arguments?: unknown[] } }[];

    expect(actions.map((a) => a.title)).toEqual(["Fix with Arcturn", "Fix with Arcturn"]);
    expect(actions[0]?.command?.command).toBe(FIX_COMMAND);
    expect(actions[0]?.command?.arguments).toEqual([
      document.uri,
      range,
      "Type 'A' is not assignable to type 'B'.",
    ]);
  });

  it("offers nothing where there is nothing wrong", () => {
    const provider = createDiagnosticFixProvider();

    const actions = provider.provideCodeActions(
      document as never,
      range as never,
      { diagnostics: [], only: undefined, triggerKind: 1 } as never,
      {} as never,
    ) as unknown[];

    expect(actions).toEqual([]);
  });

  it("never marks itself preferred, so it does not displace a real quick fix", () => {
    // Auto-fix-on-save and ctrl+. both take the preferred action. Claiming that
    // slot would make "organize imports" open a chat instead.
    const provider = createDiagnosticFixProvider();

    const actions = provider.provideCodeActions(
      document as never,
      range as never,
      { diagnostics: [{ message: "boom", range }], only: undefined, triggerKind: 1 } as never,
      {} as never,
    ) as { isPreferred?: boolean }[];

    expect(actions[0]?.isPreferred).toBeFalsy();
  });

  it("registers for on-disk files only, and declares the kind it provides", () => {
    // The mention is a path the engine resolves. An untitled buffer, a diff
    // view, or an output channel has no path to send, so the action must not
    // appear there at all.
    const disposable = registerDiagnosticFixProvider();

    expect(fake.codeActionProviders).toHaveLength(1);
    expect(fake.codeActionProviders[0]?.selector).toEqual({ scheme: "file" });
    const metadata = fake.codeActionProviders[0]?.metadata as {
      providedCodeActionKinds: { value: string }[];
    };
    expect(metadata.providedCodeActionKinds.map((kind) => kind.value)).toEqual(["quickfix"]);

    disposable.dispose();
    expect(fake.codeActionProviders).toHaveLength(0);
  });
});
