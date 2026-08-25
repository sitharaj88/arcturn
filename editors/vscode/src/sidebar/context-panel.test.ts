/**
 * RFC 0005 §1.1 on the panel's host side: the boundary contract, the projection
 * a chip is rendered from, and the controller's use of `prompt`'s new
 * parameter.
 *
 * The panel UI itself is another agent's; what is proved here is the plumbing
 * beneath it — that the shapes the page may send are validated field by field,
 * that an engine-supplied string is escaped before it reaches a rendered field,
 * and that a chip's `ok` is computed from the engine's facts rather than
 * guessed.
 */

import { describe, expect, it } from "vitest";
import { connectToServe } from "../serve/connect.js";
import type { ContextResolution, ProtocolClient } from "../serve/engine.js";
import { FakeSocket, flush } from "../serve/test-socket.js";
import { createSessionController, type SessionController } from "./controller.js";
import {
  MAX_MODEL_ID_LENGTH,
  parseWebviewMessage,
  projectContextItem,
} from "./webview-messages.js";

const TOKEN = "0123456789abcdef0123456789abcdef";
const SESSION = "session-1";

function resolution(overrides: Partial<ContextResolution> = {}): ContextResolution {
  return {
    query: "src/auth.ts",
    path: "/ws/src/auth.ts",
    relativePath: "src/auth.ts",
    inWorkspace: true,
    exists: true,
    bytes: 128,
    kind: "file",
    ...overrides,
  };
}

describe("projectContextItem", () => {
  it("marks a real workspace file attachable", () => {
    expect(projectContextItem(resolution())).toEqual({
      id: "src/auth.ts",
      path: "src/auth.ts",
      label: "src/auth.ts",
      bytes: 128,
      kind: "file",
      ok: true,
    });
  });

  it("marks an image attachable too — it becomes a vision block", () => {
    expect(projectContextItem(resolution({ kind: "image" })).ok).toBe(true);
  });

  it("refuses a directory, a missing path, and anything outside the workspace", () => {
    expect(
      projectContextItem(
        resolution({ kind: "directory", reason: "a directory cannot be attached" }),
      ).ok,
    ).toBe(false);
    expect(projectContextItem(resolution({ exists: false, bytes: 0, kind: "missing" })).ok).toBe(
      false,
    );
    const outside = projectContextItem(
      resolution({
        inWorkspace: false,
        exists: false,
        bytes: 0,
        relativePath: "",
        kind: "missing",
        reason: "resolves outside the workspace",
      }),
    );
    expect(outside.ok).toBe(false);
    // Identity falls back to the absolute path when there is no honest
    // relative spelling of one.
    expect(outside.id).toBe("/ws/src/auth.ts");
  });

  it("escapes an engine-supplied name before it reaches a rendered field", () => {
    // A filename can contain anything, and a rendered field expands `$(name)`
    // into a glyph. `path` stays raw — it is identity, and it is what the
    // engine is sent back.
    const item = projectContextItem(
      resolution({ relativePath: "$(alert) not-a-warning.ts", reason: "$(x) nope" }),
    );
    expect(item.label).toBe("\\$(alert) not-a-warning.ts");
    expect(item.path).toBe("$(alert) not-a-warning.ts");
    expect(item.reason).toBe("\\$(x) nope");
  });

  it("does not carry a size for something that does not exist", () => {
    expect(projectContextItem(resolution({ exists: false, bytes: 0, kind: "missing" })).bytes).toBe(
      0,
    );
  });
});

describe("parseWebviewMessage: the three frozen context messages", () => {
  it("accepts resolveContext, attach and detach", () => {
    expect(parseWebviewMessage({ type: "resolveContext", query: "src/a" })).toEqual({
      type: "resolveContext",
      query: "src/a",
    });
    expect(parseWebviewMessage({ type: "attach", paths: ["a.ts", "b.png"] })).toEqual({
      type: "attach",
      paths: ["a.ts", "b.png"],
    });
    expect(parseWebviewMessage({ type: "detach", id: "a.ts" })).toEqual({
      type: "detach",
      id: "a.ts",
    });
  });

  it("drops a control character in a path, which would forge a log line", () => {
    expect(parseWebviewMessage({ type: "resolveContext", query: "a\nb" })).toBeUndefined();
    expect(parseWebviewMessage({ type: "attach", paths: ["a\nb"] })).toBeUndefined();
    expect(parseWebviewMessage({ type: "detach", id: "ab" })).toBeUndefined();
  });

  it("drops an empty attach, a non-array, and a non-string element", () => {
    expect(parseWebviewMessage({ type: "attach", paths: [] })).toBeUndefined();
    expect(parseWebviewMessage({ type: "attach", paths: "a.ts" })).toBeUndefined();
    expect(parseWebviewMessage({ type: "attach", paths: [1] })).toBeUndefined();
  });

  it("bounds the number of paths one attach may carry", () => {
    const many = Array.from({ length: 65 }, (_, index) => `f${String(index)}.ts`);
    expect(parseWebviewMessage({ type: "attach", paths: many })).toBeUndefined();
    expect(parseWebviewMessage({ type: "attach", paths: many.slice(0, 64) })).toBeDefined();
  });

  it("bounds a query, and leaves the pre-existing ceilings alone", () => {
    expect(
      parseWebviewMessage({ type: "resolveContext", query: "a".repeat(4097) }),
    ).toBeUndefined();
    expect(parseWebviewMessage({ type: "resolveContext", query: "a".repeat(4096) })).toBeDefined();
    expect(MAX_MODEL_ID_LENGTH).toBe(200);
  });
});

interface Harness {
  socket: FakeSocket;
  client: ProtocolClient;
  controller: SessionController;
  diagnostics: string[];
}

async function harness(running = false): Promise<Harness> {
  const socket = new FakeSocket({
    autoRespond: (frame) =>
      frame.method === "resolveContext" ? resolution({ query: "src/auth.ts" }) : {},
  });
  const diagnostics: string[] = [];
  const client = await connectToServe({
    connectUrl: `ws://127.0.0.1:1#token=${TOKEN}`,
    socketFactory: () => socket,
    onDiagnostic: (line) => diagnostics.push(line),
  });
  await flush();
  const controller = createSessionController({
    client,
    sessionId: SESSION,
    host: {
      onChat: () => {},
      onCost: () => {},
      askPermission: async () => ({ behavior: "allow" }),
      onDiagnostic: (line) => diagnostics.push(line),
    },
  });
  if (running) {
    // A `runStart` is what makes `chooseSendVerb` pick `steer`.
    socket.emit({
      kind: "event",
      sessionId: SESSION,
      event: { type: "runStart", sessionId: SESSION, prompt: { role: "user", content: [] } },
    });
    await flush();
  }
  return { socket, client, controller, diagnostics };
}

describe("SessionController: attachments and resolveContext", () => {
  it("sends the attachments alongside the prompt", async () => {
    const { socket, controller } = await harness();
    await controller.send("summarise this", [{ kind: "file", path: "notes.md" }]);
    await flush();
    await flush();

    // The support probe fires first — a client must not hand attachments to an
    // engine that would drop them (see `ProtocolClient.prompt`).
    expect(socket.lastFrame("resolveContext")).toBeDefined();
    expect(socket.lastFrame("prompt")?.params).toEqual({
      sessionId: SESSION,
      text: "summarise this",
      attachments: [{ kind: "file", path: "notes.md" }],
    });
  });

  it("omits the field entirely when there is nothing attached", async () => {
    const { socket, controller } = await harness();
    await controller.send("hello");
    await flush();
    expect(socket.lastFrame("prompt")?.params).toEqual({ sessionId: SESSION, text: "hello" });
    // No probe either: a plain prompt costs exactly what it always did.
    expect(socket.lastFrame("resolveContext")).toBeUndefined();
  });

  it("refuses to steer with attachments rather than dropping them", async () => {
    const { socket, controller, diagnostics } = await harness(true);
    await controller.send("and this too", [{ kind: "file", path: "notes.md" }]);
    await flush();
    expect(socket.lastFrame("steer")).toBeUndefined();
    expect(socket.lastFrame("prompt")).toBeUndefined();
    expect(diagnostics.some((line) => /no attachments/.test(line))).toBe(true);
  });

  it("asks the engine what a mention resolves to", async () => {
    const { socket, controller } = await harness();
    const answer = await controller.resolveContext("src/auth.ts");
    expect(socket.lastFrame("resolveContext")?.params).toEqual({
      sessionId: SESSION,
      query: "src/auth.ts",
    });
    expect(answer?.relativePath).toBe("src/auth.ts");
  });
});
