/**
 * A streaming `write` / `edit` shows its file body as it arrives.
 *
 * With eager input streaming the provider delivers a tool's input as the
 * model writes it; the live region used to reduce minutes of a file being
 * dictated to a character count. Now the body itself — its last few lines —
 * appears under the progress line.
 */

import { stripAnsi } from "@arcturn/tui";
import type { AgentEvent, StreamEvent } from "@arcturn/types";
import { describe, expect, it } from "vitest";
import { streamingBodyPreview, ToolCallProgressTracker } from "./activity.js";
import { renderToolCallProgress } from "./widgets.js";

function streamed(event: StreamEvent): AgentEvent {
  return { type: "messageStream", event };
}

describe("streamingBodyPreview", () => {
  it("decodes a write's content as far as it has streamed, escapes included", () => {
    const raw = '{"path":"src/a.ts","content":"line one\\nline \\"two\\"\\n\\tthr';
    expect(streamingBodyPreview("write", raw)).toEqual({
      path: "src/a.ts",
      body: 'line one\nline "two"\n\tthr',
    });
  });

  it("drops a dangling escape and a half-written \\u sequence", () => {
    expect(streamingBodyPreview("write", '{"content":"ab\\')?.body).toBe("ab");
    expect(streamingBodyPreview("write", '{"content":"ab\\u00')?.body).toBe("ab");
    expect(streamingBodyPreview("write", '{"content":"\\u00e9!"}')?.body).toBe("é!");
  });

  it("reads edit's newText, waits for the body to begin, and ignores other tools", () => {
    expect(
      streamingBodyPreview("edit", '{"path":"a","oldText":"x","newText":"y\\nz'),
    ).toMatchObject({ body: "y\nz" });
    expect(streamingBodyPreview("write", '{"path":"src/a.t')).toBeUndefined();
    expect(streamingBodyPreview("bash", '{"command":"ls"}')).toBeUndefined();
  });

  it("leaves a path out until its value has fully streamed", () => {
    expect(streamingBodyPreview("write", '{"content":"x","path":"src/a')).toEqual({ body: "x" });
  });
});

describe("the live region", () => {
  it("shows the file's last lines under the progress line while it streams", () => {
    const tracker = new ToolCallProgressTracker();
    tracker.handle(streamed({ type: "toolCallStart", blockIndex: 0, id: "c1", name: "write" }));
    const chunks = ['{"path":"notes.md",', '"content":"# Title\\n\\none\\ntwo\\n', "three\\nfou"];
    for (const argumentsDelta of chunks) {
      tracker.handle(streamed({ type: "toolCallDelta", blockIndex: 0, argumentsDelta }));
    }
    const rows = renderToolCallProgress(tracker.progress, 80).map(stripAnsi);
    expect(rows[0]).toContain("write");
    expect(rows[0]).toContain("notes.md");
    expect(rows.slice(1).map((row) => row.trim())).toEqual(["one", "two", "three", "fou"]);
  });

  it("strips control characters from the body before they reach the terminal", () => {
    const rows = renderToolCallProgress(
      { name: "write", chars: 10, count: 1, preview: { body: "ok\u001b[2Jbad" } },
      80,
    ).map(stripAnsi);
    expect(rows[1]).not.toContain("\u001b");
  });

  it("keeps no body for a tool that has none to preview", () => {
    const tracker = new ToolCallProgressTracker();
    tracker.handle(streamed({ type: "toolCallStart", blockIndex: 0, id: "c1", name: "bash" }));
    tracker.handle(
      streamed({ type: "toolCallDelta", blockIndex: 0, argumentsDelta: '{"command":"ls"}' }),
    );
    expect(tracker.progress).toEqual({ name: "bash", chars: 16, count: 1 });
  });
});
