import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedCli } from "./cli.js";
import { activateWith } from "./extension.js";
import { fake, resetFake } from "./test-vscode.js";

vi.mock("vscode", async () => (await import("./test-vscode.js")).createFakeVscode());

// Stage 2 as it exists before Builder B lands: the module is there, the export
// is not. A and B are built in parallel and A must ship green on its own.
//
// Spelled as an explicit `undefined` rather than `{}` because vitest's mock
// namespace is a proxy that *throws* on an unknown export, where the bundled
// CommonJS module the extension actually loads just yields `undefined`. This
// is the shape production sees.
vi.mock("./sidebar/index.js", () => ({ activateSidebar: undefined }));

const cli: ResolvedCli = { command: "/usr/local/bin/arcturn", source: "path", version: "0.2.0" };

beforeEach(() => {
  resetFake();
});

describe("activation before the sidebar exists", () => {
  it("activates the terminal half and says nothing alarming", async () => {
    const context = { subscriptions: [] as { dispose(): void }[] };

    await activateWith(context as never, {
      provisioner: {
        resolveCli: async () => cli,
        runInstall: () => {},
        provisionInBackground: () => {},
        settled: async () => {},
        dispose: () => {},
      },
      hub: { open: () => ({}) as never, sendInput: async () => {}, dispose: () => {} },
      platform: "darwin",
    });

    expect(fake.commands.has("arcturn.open")).toBe(true);
    // A missing Stage 2 is not an error the user can act on. The manifest
    // hides the view behind the same setting, so nothing looks broken.
    expect(fake.messages).toEqual([]);
  });
});
