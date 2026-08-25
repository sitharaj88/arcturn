/**
 * What a rewind row says a choice costs, and what the modal names before it
 * happens.
 *
 * Both are the safety property of this feature rather than its presentation:
 * `rewindTo` overwrites files and deletes files, and a person is entitled to
 * see which and how many before the click that does it.
 */

import { describe, expect, it } from "vitest";
import type { CheckpointEntry, CheckpointList } from "../serve/engine.js";
import {
  confirmsRewind,
  describeRewind,
  projectCheckpoint,
  REWIND,
  toRewindView,
} from "./rewind.js";

function entry(overrides: Partial<CheckpointEntry> = {}): CheckpointEntry {
  return {
    id: "turn-1",
    label: "add rate limiting",
    timestamp: 1_700_000_000_000,
    fileCount: 2,
    deleteCount: 1,
    files: ["src/auth.ts", "src/limiter.ts"],
    truncatedFiles: false,
    forksConversation: true,
    confirmation: "deadbeefdeadbeefdeadbeefdeadbeef",
    ...overrides,
  };
}

function list(overrides: Partial<CheckpointList> = {}): CheckpointList {
  return {
    sessionId: "s1",
    checkpoints: [entry()],
    available: true,
    truncated: false,
    droppedCheckpoints: 0,
    ...overrides,
  };
}

describe("toRewindView — three 'no rewind' stories, told apart", () => {
  it("reads an engine with no verb as unavailable", () => {
    // That engine could not have rewound anything either, so the panel offers
    // no affordance rather than one that would fail — RFC 0005 §3.
    expect(toRewindView(undefined)).toEqual({
      status: "unavailable",
      checkpoints: [],
      truncated: false,
    });
  });

  it("keeps 'this engine keeps no checkpoints' apart from 'none recorded yet'", () => {
    expect(toRewindView(list({ available: false })).status).toBe("off");
    expect(toRewindView(list({ checkpoints: [] })).status).toBe("ready");
  });

  it("carries the engine's truncation through", () => {
    expect(toRewindView(list({ truncated: true, droppedCheckpoints: 40 })).truncated).toBe(true);
  });
});

describe("projectCheckpoint — the row's second line is the price", () => {
  it("names the file count and the deletions separately", () => {
    // "12 files changed" and "12 files deleted" are not the same sentence, and
    // a row that folded them would let somebody approve the second while
    // reading the first.
    expect(projectCheckpoint(entry()).detail).toBe("2 files · 1 deleted");
  });

  it("says nothing about deletions when there are none", () => {
    expect(projectCheckpoint(entry({ fileCount: 1, deleteCount: 0, files: ["a.ts"] })).detail).toBe(
      "1 file",
    );
  });

  it("warns when only the files would move", () => {
    // The terminal's own warning, on the row: a turn whose conversation link
    // predates the process restores files and leaves the transcript describing
    // work that is no longer on disk.
    expect(projectCheckpoint(entry({ forksConversation: false })).detail).toContain(
      "the transcript stays put",
    );
  });

  it("escapes a label and a path, because both reach a notification", () => {
    const row = projectCheckpoint(
      entry({ label: "$(verified) approved", files: ["$(check) ok.ts"], fileCount: 1 }),
    );
    // Escaped, not stripped: the text survives and the codicon does not fire.
    expect(row.label).toBe("\\$(verified) approved");
    expect(row.files[0]).toBe("\\$(check) ok.ts");
  });

  it("leaves the confirmation exactly as the engine spelled it", () => {
    // Identity, not display: it goes back to the engine, and escaping it would
    // make every rewind fail the drift check.
    expect(projectCheckpoint(entry()).confirmation).toBe("deadbeefdeadbeefdeadbeefdeadbeef");
  });
});

describe("describeRewind — the modal a person actually consents to", () => {
  it("names the file count in the question and the files in the detail", () => {
    const prompt = describeRewind(projectCheckpoint(entry()));
    expect(prompt.message).toContain("2 files");
    expect(prompt.message).toContain("add rate limiting");
    expect(prompt.detail).toContain("src/auth.ts");
    expect(prompt.detail).toContain("src/limiter.ts");
    expect(prompt.detail).toContain("cannot be undone");
    expect(prompt.confirmLabel).toBe(REWIND);
  });

  it("says how many files are deleted outright", () => {
    expect(describeRewind(projectCheckpoint(entry())).detail).toMatch(/1 of them is deleted/);
    expect(
      describeRewind(
        projectCheckpoint(entry({ deleteCount: 3, fileCount: 3, files: ["a", "b", "c"] })),
      ).detail,
    ).toMatch(/3 of them are deleted/);
  });

  it("does not claim a deletion when there is none", () => {
    expect(describeRewind(projectCheckpoint(entry({ deleteCount: 0 }))).detail).not.toMatch(
      /deleted/,
    );
  });

  it("warns, before the click, when the transcript will not move with the files", () => {
    const prompt = describeRewind(projectCheckpoint(entry({ forksConversation: false })));
    expect(prompt.detail).toContain("only the files move");
  });

  it("caps the named files and says how many more there are", () => {
    const files = Array.from({ length: 20 }, (_unused, i) => `src/f${String(i)}.ts`);
    const prompt = describeRewind(
      projectCheckpoint(entry({ files, fileCount: 20, deleteCount: 0 })),
    );
    expect(prompt.detail).toContain("and 12 more");
  });
});

describe("confirmsRewind — everything that is not a yes is a no", () => {
  it("accepts only the confirm label", () => {
    const prompt = describeRewind(projectCheckpoint(entry()));
    expect(confirmsRewind(REWIND, prompt)).toBe(true);
    // A dismissed modal (Escape, VS Code's own Cancel) and an unrecognised
    // button both mean *do not rewind*: treating "no answer" as consent is the
    // one failure mode a destructive action may not have.
    expect(confirmsRewind(undefined, prompt)).toBe(false);
    expect(confirmsRewind("Cancel", prompt)).toBe(false);
    expect(confirmsRewind("rewind", prompt)).toBe(false);
  });
});
