/**
 * The `@` picker's decisions, driven as functions.
 *
 * Same technique as `webview-models.test.ts`: `CONTEXT_SOURCE` is the text the
 * webview runs, compiled here so these tests exercise the shipped bytes.
 * Everything under test is pure — a query and a candidate list in, an ordering
 * or a sentence out — so there is no DOM and no `vscode`.
 */

import { describe, expect, it } from "vitest";
import {
  CONTEXT_SOURCE,
  contextGlob,
  MAX_CONTEXT_CANDIDATES,
  narrowCandidates,
} from "./webview-context.js";
import type { ContextItem } from "./webview-messages.js";

interface Trigger {
  marker: string;
  query: string;
  start: number;
  end: number;
}

const api = new Function(
  `${CONTEXT_SOURCE}\nreturn { formatBytes, contextMeta, ambientMeta, ambientTitle, contextScore, rankContext, orderCandidates, triggerAt, applyTrigger };`,
)() as {
  formatBytes: (bytes: number) => string;
  contextMeta: (item: ContextItem) => string;
  ambientMeta: (item: ContextItem & { selection?: unknown }) => string;
  ambientTitle: (item: ContextItem & { selection?: unknown }) => string;
  contextScore: (path: string, query: string) => number;
  rankContext: (items: ContextItem[], query: string) => ContextItem[];
  orderCandidates: (items: ContextItem[], query: string) => ContextItem[];
  triggerAt: (text: string, caret: number) => Trigger | undefined;
  applyTrigger: (text: string, trigger: Trigger, insert: string) => { text: string; caret: number };
};

function item(over: Partial<ContextItem> & { id: string }): ContextItem {
  return {
    path: over.id,
    label: over.id,
    bytes: 1024,
    kind: "file",
    ok: true,
    ...over,
  };
}

describe("formatBytes", () => {
  it("says nothing about a size nobody measured", () => {
    expect(api.formatBytes(0)).toBe("");
    expect(api.formatBytes(-1)).toBe("");
    expect(api.formatBytes(Number.NaN)).toBe("");
  });

  it("counts small files in bytes and larger ones in the unit a person reads", () => {
    expect(api.formatBytes(1)).toBe("1 B");
    expect(api.formatBytes(812)).toBe("812 B");
    expect(api.formatBytes(1024)).toBe("1.0 KB");
    expect(api.formatBytes(4300)).toBe("4.2 KB");
    expect(api.formatBytes(1024 * 1024 * 3.5)).toBe("3.5 MB");
  });
});

describe("contextMeta", () => {
  it("shows the real size of a file that will actually be sent", () => {
    expect(api.contextMeta(item({ id: "src/auth.ts", bytes: 4300 }))).toBe("4.2 KB");
  });

  it("shows the engine's own reason for one that will not", () => {
    expect(
      api.contextMeta(
        item({ id: "../../etc/passwd", ok: false, bytes: 0, reason: "outside the workspace" }),
      ),
    ).toBe("outside the workspace");
  });

  it("still says something when the engine refused without a reason", () => {
    expect(api.contextMeta(item({ id: "x", ok: false, bytes: 0 }))).not.toBe("");
  });

  it("names an image as one, so a chip about to be sent to a text-only model reads as an image", () => {
    expect(api.contextMeta(item({ id: "a.png", kind: "image", bytes: 2048 }))).toContain("image");
  });
});

describe("contextScore", () => {
  it("refuses a path that does not contain the query's letters in order", () => {
    expect(api.contextScore("src/auth.ts", "zzz")).toBe(-1);
    expect(api.contextScore("src/auth.ts", "hta")).toBe(-1);
  });

  it("matches a subsequence rather than only a substring, which is the point of fuzzy", () => {
    expect(api.contextScore("src/auth.ts", "sath")).toBeGreaterThanOrEqual(0);
  });

  it("prefers a hit in the basename over one buried in a directory", () => {
    const inName = api.contextScore("packages/x/auth.ts", "auth");
    const inDir = api.contextScore("auth/packages/x/zzzz.ts", "auth");
    expect(inName).toBeLessThan(inDir);
  });

  it("prefers a run of consecutive letters over the same letters scattered", () => {
    expect(api.contextScore("src/auth.ts", "auth")).toBeLessThan(
      api.contextScore("src/a-u-t-h.ts", "auth"),
    );
  });

  it("matches everything on an empty query, so `@` alone opens a browsable list", () => {
    expect(api.contextScore("anything", "")).toBeGreaterThanOrEqual(0);
  });

  it("ignores case, because nobody types a path with its capitals", () => {
    expect(api.contextScore("src/Auth.ts", "auth")).toBeGreaterThanOrEqual(0);
  });
});

describe("rankContext", () => {
  const files = [
    item({ id: "packages/core/authenticate.ts" }),
    item({ id: "src/auth.ts" }),
    item({ id: "docs/rfcs/0004-a-u-t-h.md" }),
    item({ id: "README.md" }),
  ];

  it("drops what cannot match and puts the best guess first", () => {
    expect(api.rankContext(files, "auth").map((row) => row.id)).toEqual([
      "src/auth.ts",
      "packages/core/authenticate.ts",
      "docs/rfcs/0004-a-u-t-h.md",
    ]);
  });

  it("leaves the host's own order alone when nothing was typed", () => {
    expect(api.rankContext(files, "").map((row) => row.id)).toEqual(files.map((row) => row.id));
  });

  it("keeps a candidate the engine refused, so the picker can say why", () => {
    const refused = [item({ id: "node_modules/x/auth.ts", ok: false, reason: "ignored" })];
    expect(api.rankContext(refused, "auth")).toHaveLength(1);
  });
});

describe("triggerAt", () => {
  it("opens on an @ at the very start of the message", () => {
    expect(api.triggerAt("@src", 4)).toEqual({ marker: "@", query: "src", start: 0, end: 4 });
  });

  it("opens on an @ after a space, which is where a mention actually goes", () => {
    expect(api.triggerAt("look at @src/a", 14)).toMatchObject({ marker: "@", query: "src/a" });
  });

  it("does not open on an @ inside a word, so an email address is left alone", () => {
    expect(api.triggerAt("mail me@example.com", 19)).toBeUndefined();
  });

  it("opens on a / only at the start, so a path is not a command menu", () => {
    expect(api.triggerAt("/rev", 4)).toEqual({ marker: "/", query: "rev", start: 0, end: 4 });
    expect(api.triggerAt("read src/auth.ts", 16)).toBeUndefined();
  });

  it("closes as soon as the query runs into whitespace", () => {
    expect(api.triggerAt("@src/auth.ts and now prose", 26)).toBeUndefined();
    expect(api.triggerAt("/review this file", 17)).toBeUndefined();
  });

  it("reads the text up to the caret, not the whole box", () => {
    expect(api.triggerAt("@src trailing", 4)).toMatchObject({ query: "src", end: 4 });
  });

  it("gives up on a query long enough to be prose rather than a path", () => {
    expect(api.triggerAt(`@${"x".repeat(300)}`, 301)).toBeUndefined();
  });

  it("stays closed when there is no marker at all", () => {
    expect(api.triggerAt("just a sentence", 15)).toBeUndefined();
  });
});

describe("applyTrigger", () => {
  const trigger = { marker: "@", query: "sr", start: 8, end: 10 };

  it("replaces exactly the trigger and leaves the rest of the message alone", () => {
    expect(api.applyTrigger("look at sr now", trigger, "")).toEqual({
      text: "look at  now",
      caret: 8,
    });
  });

  it("puts the caret after what it inserted, ready for the next word", () => {
    expect(
      api.applyTrigger("/rev", { marker: "/", query: "rev", start: 0, end: 4 }, "/review "),
    ).toEqual({ text: "/review ", caret: 8 });
  });
});

describe("contextGlob", () => {
  it("asks the workspace index for everything when nothing has been typed", () => {
    expect(contextGlob("")).toBe("**/*");
  });

  it("turns the query into a subsequence, so the index does the fuzzy matching", () => {
    expect(contextGlob("auth")).toBe("**/*a*u*t*h*");
  });

  it("keeps a path separator a separator, so `src/auth` is two segments", () => {
    expect(contextGlob("src/auth")).toBe("**/*s*r*c*/*a*u*t*h*");
  });

  it("strips glob syntax out of the query rather than letting a user write a pattern", () => {
    // A '*' or a '{a,b}' typed after '@' is a character somebody meant
    // literally, and forwarding it would let the composer author a glob that
    // walks the workspace in ways the picker never intended.
    expect(contextGlob("a*b")).toBe("**/*a*b*");
    expect(contextGlob("{a,b}")).toBe("**/*a*b*");
    expect(contextGlob("!x")).toBe("**/*x*");
  });

  it("does not build an unbounded pattern out of an unbounded query", () => {
    expect(contextGlob("x".repeat(400)).length).toBeLessThan(200);
  });

  it("falls back to everything when the query was only punctuation", () => {
    expect(contextGlob("***")).toBe("**/*");
  });
});

describe("narrowCandidates", () => {
  it("keeps the shortest paths when more match than the picker can resolve", () => {
    const paths = ["node_modules/@scope/pkg/dist/auth.js", "src/auth.ts", "packages/core/auth.ts"];
    expect(narrowCandidates(paths, 2)).toEqual(["src/auth.ts", "packages/core/auth.ts"]);
  });

  it("is stable on a tie, so the same query twice is the same list twice", () => {
    expect(narrowCandidates(["b/x.ts", "a/x.ts"], 2)).toEqual(["a/x.ts", "b/x.ts"]);
  });

  it("drops a duplicate rather than resolving the same file twice", () => {
    expect(narrowCandidates(["a.ts", "a.ts", "b.ts"], 12)).toEqual(["a.ts", "b.ts"]);
  });

  it("never asks for more round trips than the cap allows", () => {
    const many = Array.from({ length: 200 }, (_, index) => `f${String(index)}.ts`);
    expect(narrowCandidates(many).length).toBe(MAX_CONTEXT_CANDIDATES);
  });
});

describe("orderCandidates", () => {
  const files = [
    item({ id: "docs/plan.md" }),
    item({ id: "src/auth.ts" }),
    item({ id: "/etc/passwd", ok: false, reason: "outside the workspace" }),
  ];

  it("ranks what matches and keeps what does not, rather than filtering twice", () => {
    // The host always includes the path the user typed, which is what makes
    // `@../../etc/passwd` answerable with the engine's refusal. A page that
    // dropped it would throw away the one row with something to say.
    expect(api.orderCandidates(files, "auth").map((row) => row.id)).toEqual([
      "src/auth.ts",
      "docs/plan.md",
      "/etc/passwd",
    ]);
  });

  it("leaves a list where everything matched exactly as rankContext ordered it", () => {
    const matched = [item({ id: "packages/x/auth.ts" }), item({ id: "auth.ts" })];
    expect(api.orderCandidates(matched, "auth").map((row) => row.id)).toEqual([
      "auth.ts",
      "packages/x/auth.ts",
    ]);
  });
});

describe("what the ambient chip says will happen", () => {
  const looking = {
    id: "src/auth.ts",
    path: "src/auth.ts",
    label: "src/auth.ts",
    bytes: 4300,
    kind: "file" as const,
    ok: true,
  };

  it("says nothing at all where a size used to sit", () => {
    // The size was true when an open file was attached whole, and became a lie
    // once it travelled as `kind: "fileReference"`. The replacement — a
    // sentence explaining that the contents are not sent — fixed the lie and
    // added a disclaimer to every caret move. The other two states carry
    // measurements a reader can act on; naming a file has no such number, so
    // this one carries none, and the chip is just the filename. The reasoning
    // lives on the hover, which `ambientTitle` still supplies.
    expect(api.ambientMeta(looking)).toBe("");
    expect(api.ambientTitle(looking)).toContain("reads it itself");
  });

  it("keeps the '@' chip's wording for an ambient image, which does travel whole", () => {
    // `read` does not answer "is this screenshot relevant", so an image is
    // still sent — and must not borrow a promise nobody is making about it.
    expect(api.ambientMeta({ ...looking, kind: "image" })).toBe("image · 4.2 KB");
  });

  it("counts the selected lines, because that is what now goes", () => {
    // `PromptAttachment` carries a range and `expandMentions` reads one, so the
    // label naming 12-40 describes what is sent. This line used to read "whole
    // file" — it was the word designed to change when the wire learned to carry
    // a range, and the label was designed not to. The size stays the file's,
    // because that is the number the engine measured before it sliced.
    expect(api.ambientMeta({ ...looking, selection: { startLine: 12, endLine: 40 } })).toBe(
      "29 lines of 4.2 KB",
    );
  });

  it("says one line rather than 1 lines, and drops the size nothing measured", () => {
    expect(api.ambientMeta({ ...looking, bytes: 0, selection: { startLine: 7, endLine: 7 } })).toBe(
      "1 line",
    );
  });

  it("gives the engine's refusal, not a size, for a file it will not read", () => {
    expect(
      api.ambientMeta({
        ...looking,
        ok: false,
        bytes: 0,
        reason: "escapes the workspace",
        selection: { startLine: 1, endLine: 2 },
      }),
    ).toBe("escapes the workspace");
  });

  it("explains itself on hover, and now only bothers to when NOTHING is selected", () => {
    // The condition inverted, and that is the point. A selection used to be
    // the surprising case ("we name the lines and send the file"); it is now
    // the plain one. The open file with nothing selected is what needs saying.
    const plain = api.ambientTitle(looking);
    expect(plain).toContain("src/auth.ts");
    expect(plain).toContain("read");
    // Naming the size on the hover is honest here in a way it is not on the
    // meta line: it is what is *not* spent, per turn.
    expect(plain).toContain("4.2 KB a turn");
    expect(plain).not.toContain("whole file");

    const ranged = api.ambientTitle({ ...looking, selection: { startLine: 12, endLine: 40 } });
    expect(ranged).toBe("src/auth.ts\n29 lines of 4.2 KB");
    expect(ranged).not.toContain("whole file");
  });

  it("says nothing extra over a chip the engine already refused", () => {
    const refused = api.ambientTitle({
      ...looking,
      ok: false,
      bytes: 0,
      reason: "escapes the workspace",
    });
    expect(refused).toBe("src/auth.ts\nescapes the workspace");
  });
});
