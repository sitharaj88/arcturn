import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { validatePromptAttachment } from "@arcturn/protocol";
import { PROMPT_ATTACHMENT_MAX_BYTES } from "@arcturn/server";
import { beforeEach, describe, expect, it } from "vitest";
import { createContextResolver } from "./context.js";
import { IMAGE_MIME_TYPES } from "./mentions.js";

let cwd: string;
let outside: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "arcturn-ctx-"));
  outside = await mkdtemp(join(tmpdir(), "arcturn-ctx-out-"));
});

const resolver = createContextResolver();

describe("createContextResolver().buildPrompt", () => {
  it("expands mentions through the same function the TUI calls", async () => {
    await writeFile(join(cwd, "a.txt"), "MENTION_SENTINEL\n", "utf8");
    const result = await resolver.buildPrompt({ cwd, text: "see @a.txt", attachments: [] });
    expect(result.text).toContain("MENTION_SENTINEL");
    expect(result.text).toContain("@a.txt:");
    expect(result.refusals).toEqual([]);
  });

  it("attaches an absolute mention from anywhere — the explicit path is the consent", async () => {
    await writeFile(join(outside, "s.txt"), "OUTSIDE\n", "utf8");
    const result = await resolver.buildPrompt({
      cwd,
      text: `read @${join(outside, "s.txt")}`,
      attachments: [],
    });
    expect(result.text).toContain("OUTSIDE");
    expect(result.refusals).toEqual([]);
  });

  it("reports a covert escape — a relative mention leaving the workspace — instead of skipping it silently", async () => {
    await writeFile(join(outside, "s.txt"), "OUTSIDE\n", "utf8");
    const result = await resolver.buildPrompt({
      cwd,
      text: `read @${relative(cwd, join(outside, "s.txt")).split(sep).join("/")}`,
      attachments: [],
    });
    expect(result.text).not.toContain("OUTSIDE");
    expect(result.refusals).toHaveLength(1);
    expect(result.refusals[0]?.reason).toMatch(/outside the workspace/);
  });

  it("says nothing about a mention that merely does not exist", async () => {
    // The noise floor matters: `@here` in ordinary prose must not produce a
    // warning, or the warnings stop being read.
    const result = await resolver.buildPrompt({ cwd, text: "hey @here", attachments: [] });
    expect(result.refusals).toEqual([]);
  });

  it("heads a file attachment so the block says what it is", async () => {
    await writeFile(join(cwd, "n.md"), "ATTACHED\n", "utf8");
    const result = await resolver.buildPrompt({
      cwd,
      text: "summarise",
      attachments: [{ kind: "file", path: "n.md" }],
    });
    expect(result.text).toContain("n.md (attached file):");
    expect(result.text).toContain("ATTACHED");
  });

  it("attaches an absolute attachment from anywhere", async () => {
    await writeFile(join(outside, "s.txt"), "OUTSIDE\n", "utf8");
    const result = await resolver.buildPrompt({
      cwd,
      text: "look",
      attachments: [{ kind: "file", path: join(outside, "s.txt") }],
    });
    expect(result.text).toContain("OUTSIDE");
  });

  it("refuses a covert relative attachment outside the workspace, fatally", async () => {
    await writeFile(join(outside, "s.txt"), "OUTSIDE\n", "utf8");
    await expect(
      resolver.buildPrompt({
        cwd,
        text: "look",
        attachments: [
          { kind: "file", path: relative(cwd, join(outside, "s.txt")).split(sep).join("/") },
        ],
      }),
    ).rejects.toThrow(/outside the workspace/);
  });

  it("refuses an attachment reached through a symlink that leaves the workspace", async () => {
    // The lexical check passes here and the read would still have escaped: this
    // is the case `security-review.test.ts` pinned for mentions, now proved for
    // the attachment path that shares the gate.
    await writeFile(join(outside, "s.txt"), "OUTSIDE\n", "utf8");
    await symlink(join(outside, "s.txt"), join(cwd, "link.txt"));
    await expect(
      resolver.buildPrompt({
        cwd,
        text: "look",
        attachments: [{ kind: "file", path: "link.txt" }],
      }),
    ).rejects.toThrow(/symlink leading outside the workspace/);
  });

  it("refuses a directory attachment rather than reading something arbitrary", async () => {
    await mkdir(join(cwd, "sub"), { recursive: true });
    await expect(
      resolver.buildPrompt({ cwd, text: "look", attachments: [{ kind: "file", path: "sub" }] }),
    ).rejects.toThrow(/is not a file/);
  });

  it("bounds total attachment bytes across attachments, not per attachment", async () => {
    await writeFile(join(cwd, "a.txt"), "a".repeat(400), "utf8");
    await writeFile(join(cwd, "b.txt"), "b".repeat(400), "utf8");
    const capped = createContextResolver({ maxAttachmentBytes: 600 });
    // Either alone fits; together they do not. A per-item limit that sums to
    // anything is not a limit.
    await expect(
      capped.buildPrompt({ cwd, text: "x", attachments: [{ kind: "file", path: "a.txt" }] }),
    ).resolves.toBeDefined();
    await expect(
      capped.buildPrompt({
        cwd,
        text: "x",
        attachments: [
          { kind: "file", path: "a.txt" },
          { kind: "file", path: "b.txt" },
        ],
      }),
    ).rejects.toThrow(/attachment budget/);
  });

  it("defaults the budget to the wire's own backpressure threshold", () => {
    expect(PROMPT_ATTACHMENT_MAX_BYTES).toBe(1024 * 1024);
  });

  it("tags an inline image as an attachment, and a mentioned one as a mention", async () => {
    // 1x1 PNG.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    await writeFile(join(cwd, "p.png"), png);
    const result = await resolver.buildPrompt({
      cwd,
      text: "look at @p.png",
      attachments: [{ kind: "image", data: png.toString("base64"), mimeType: "image/png" }],
    });
    expect(result.images.map((image) => image.source)).toEqual(["mention", "attachment"]);
    // The label is what a vision refusal quotes, so it has to name the file.
    expect(result.images[0]?.label).toBe("p.png");
  });

  it("refuses an inline media type this engine cannot send", async () => {
    await expect(
      resolver.buildPrompt({
        cwd,
        text: "x",
        attachments: [{ kind: "image", data: "AAAA", mimeType: "image/tiff" }],
      }),
    ).rejects.toThrow(/not one this engine can send/);
  });
});

describe("createContextResolver().resolve", () => {
  it("reports a real file honestly", async () => {
    await writeFile(join(cwd, "n.md"), "hello\n", "utf8");
    expect(await resolver.resolve({ cwd, query: "n.md" })).toMatchObject({
      relativePath: "n.md",
      inWorkspace: true,
      exists: true,
      bytes: 6,
      kind: "file",
    });
  });

  it("tolerates the mention as typed, `@` included", async () => {
    await writeFile(join(cwd, "n.md"), "hello\n", "utf8");
    const withAt = await resolver.resolve({ cwd, query: "@n.md" });
    expect(withAt).toMatchObject({ relativePath: "n.md", exists: true });
    // The query comes back exactly as asked, so a client can key its chips on it.
    expect(withAt.query).toBe("@n.md");
  });

  it("calls an image an image, so a picker knows it will become a vision block", async () => {
    await writeFile(join(cwd, "p.png"), Buffer.from([0]));
    expect(await resolver.resolve({ cwd, query: "p.png" })).toMatchObject({ kind: "image" });
  });

  it("separates 'outside the workspace' from 'does not exist'", async () => {
    await writeFile(join(outside, "s.txt"), "OUTSIDE\n", "utf8");

    // An absolute query resolves honestly: attachable, and not in the
    // workspace — the picker can label it as elsewhere.
    const elsewhere = await resolver.resolve({ cwd, query: join(outside, "s.txt") });
    expect(elsewhere).toMatchObject({ inWorkspace: false, exists: true, kind: "file" });

    // The covert relative escape stays a wall, and stays a *blind* one: no
    // stat, so this read-only verb is no filesystem oracle for the paths
    // confinement hides.
    const escaped = await resolver.resolve({
      cwd,
      query: relative(cwd, join(outside, "s.txt")).split(sep).join("/"),
    });
    expect(escaped).toMatchObject({
      inWorkspace: false,
      exists: false,
      bytes: 0,
      relativePath: "",
    });
    expect(escaped.reason).toMatch(/outside the workspace/);

    const missing = await resolver.resolve({ cwd, query: "nope.md" });
    expect(missing).toMatchObject({ inWorkspace: true, exists: false, kind: "missing" });
  });

  it("refuses a directory with a reason a picker can render", async () => {
    await mkdir(join(cwd, "sub"), { recursive: true });
    const dir = await resolver.resolve({ cwd, query: "sub" });
    expect(dir).toMatchObject({ inWorkspace: true, exists: true, bytes: 0, kind: "directory" });
    expect(dir.reason).toMatch(/directory/);
  });

  it("resolves an empty query to the workspace root rather than failing", async () => {
    // This is what `ProtocolClient`'s support probe leans on.
    expect(await resolver.resolve({ cwd, query: "." })).toMatchObject({
      inWorkspace: true,
      kind: "directory",
    });
  });
});

describe("createContextResolver() — ranged file attachments", () => {
  /** A file whose every line names itself, 1-based and zero-padded. */
  function numbered(count: number): string {
    const lines: string[] = [];
    for (let i = 1; i <= count; i++) lines.push(`L${String(i).padStart(3, "0")}`);
    return `${lines.join("\n")}\n`;
  }

  it("injects only the selected lines, headed as an excerpt", async () => {
    await writeFile(join(cwd, "big.ts"), numbered(60), "utf8");
    const result = await resolver.buildPrompt({
      cwd,
      text: "explain",
      attachments: [{ kind: "file", path: "big.ts", range: { start: 12, end: 14 } }],
    });
    expect(result.text).toContain("big.ts (attached file) — excerpt, lines 12-14 of 60");
    expect(result.text).toContain("L012");
    expect(result.text).toContain("L014");
    expect(result.text).not.toContain("L011");
    expect(result.text).not.toContain("L015");
  });

  it("counts lines the way `wc -l` does, so a trailing newline is not a line", async () => {
    await writeFile(join(cwd, "two.txt"), "alpha\nbeta\n", "utf8");
    const result = await resolver.buildPrompt({
      cwd,
      text: "x",
      attachments: [{ kind: "file", path: "two.txt", range: { start: 1, end: 2 } }],
    });
    expect(result.text).toContain("excerpt, lines 1-2 of 2");
    expect(result.text).toContain("alpha\nbeta");
  });

  it("clamps an editor's phantom final line rather than refusing it", async () => {
    // VS Code reports three lines for "alpha\nbeta\n"; the third is empty.
    // A selection that includes it must not fail — it must clamp.
    await writeFile(join(cwd, "two.txt"), "alpha\nbeta\n", "utf8");
    const result = await resolver.buildPrompt({
      cwd,
      text: "x",
      attachments: [{ kind: "file", path: "two.txt", range: { start: 1, end: 3 } }],
    });
    expect(result.text).toContain("excerpt, lines 1-2 of 2");
    expect(result.text).toContain("clamped");
  });

  it("clamps an absurd end rather than refusing it, and says what was asked for", async () => {
    await writeFile(join(cwd, "big.ts"), numbered(60), "utf8");
    const result = await resolver.buildPrompt({
      cwd,
      text: "explain",
      attachments: [{ kind: "file", path: "big.ts", range: { start: 1, end: 10_000_000 } }],
    });
    expect(result.text).toContain("excerpt, lines 1-60 of 60");
    expect(result.text).toContain("1-10000000 was requested");
    expect(result.text).toContain("the file ends at line 60");
  });

  it("refuses a start past the end of the file, fatally, rather than an empty block", async () => {
    await writeFile(join(cwd, "big.ts"), numbered(60), "utf8");
    await expect(
      resolver.buildPrompt({
        cwd,
        text: "explain",
        attachments: [{ kind: "file", path: "big.ts", range: { start: 61, end: 70 } }],
      }),
    ).rejects.toThrow(/starts at line 61, but the file has 60 lines/);
  });

  it("refuses a range against an empty file", async () => {
    await writeFile(join(cwd, "empty.txt"), "", "utf8");
    await expect(
      resolver.buildPrompt({
        cwd,
        text: "explain",
        attachments: [{ kind: "file", path: "empty.txt", range: { start: 1, end: 2 } }],
      }),
    ).rejects.toThrow(/the file is empty/);
  });

  it("refuses a range on an image attached as a file", async () => {
    await writeFile(join(cwd, "shot.png"), Buffer.from("AAAA", "base64"));
    await expect(
      resolver.buildPrompt({
        cwd,
        text: "explain",
        attachments: [{ kind: "file", path: "shot.png", range: { start: 1, end: 2 } }],
      }),
    ).rejects.toThrow(/image/);
  });

  it("still refuses a ranged attachment reached through an escaping symlink", async () => {
    // The lexical check passes here; only the symlink-resolved comparison
    // catches it. A range must not become a second way in.
    await writeFile(join(outside, "s.txt"), numbered(60).replace(/L/g, "OUT"), "utf8");
    await symlink(join(outside, "s.txt"), join(cwd, "link.txt"));
    await expect(
      resolver.buildPrompt({
        cwd,
        text: "look",
        attachments: [{ kind: "file", path: "link.txt", range: { start: 1, end: 2 } }],
      }),
    ).rejects.toThrow(/symlink leading outside the workspace/);
  });

  it("still confines a covert ranged attachment; an absolute one reads its excerpt", async () => {
    await writeFile(join(outside, "s.txt"), numbered(60).replace(/L/g, "OUT"), "utf8");
    await expect(
      resolver.buildPrompt({
        cwd,
        text: "explain",
        attachments: [
          {
            kind: "file",
            path: relative(cwd, join(outside, "s.txt")).split(sep).join("/"),
            range: { start: 1, end: 2 },
          },
        ],
      }),
    ).rejects.toThrow(/outside the workspace/);

    const allowed = await resolver.buildPrompt({
      cwd,
      text: "explain",
      attachments: [{ kind: "file", path: join(outside, "s.txt"), range: { start: 1, end: 2 } }],
    });
    expect(allowed.text).toContain("OUT001");
    expect(allowed.text).not.toContain("OUT060");
  });

  it("charges the byte budget for the excerpt, not for the file it came from", async () => {
    await writeFile(join(cwd, "big.ts"), numbered(60), "utf8");
    const tight = createContextResolver({ maxAttachmentBytes: 200 });
    await expect(
      tight.buildPrompt({ cwd, text: "x", attachments: [{ kind: "file", path: "big.ts" }] }),
    ).rejects.toThrow(/attachment budget/);
    const excerpt = await tight.buildPrompt({
      cwd,
      text: "x",
      attachments: [{ kind: "file", path: "big.ts", range: { start: 12, end: 14 } }],
    });
    expect(excerpt.text).toContain("L013");
  });

  it("echoes a resolveContext range back without reading the file", async () => {
    await writeFile(join(cwd, "big.ts"), numbered(60), "utf8");
    // The echo is a statement about the *parameter*, not about the file: it is
    // what tells a client this engine will not silently drop the range. It is
    // answered for a path that does not fit the range, and for one that is not
    // a file at all.
    expect(
      await resolver.resolve({ cwd, query: "big.ts", range: { start: 1, end: 9999 } }),
    ).toMatchObject({ kind: "file", range: { start: 1, end: 9999 } });
    expect(await resolver.resolve({ cwd, query: ".", range: { start: 1, end: 1 } })).toMatchObject({
      kind: "directory",
      range: { start: 1, end: 1 },
    });
    expect(
      await resolver.resolve({ cwd, query: "../nope", range: { start: 1, end: 1 } }),
    ).toMatchObject({ inWorkspace: false, range: { start: 1, end: 1 } });
    // And absent when nothing was asked, which is the half that makes it a
    // usable signal.
    expect(await resolver.resolve({ cwd, query: "big.ts" })).not.toHaveProperty("range");
  });
});

describe("the wire's inline media allowlist and the engine's own list agree", () => {
  it("accepts exactly the media types this engine can send", () => {
    // `@arcturn/protocol` cannot import `@arcturn/cli`, so its inline-image
    // allowlist is necessarily a second copy of `IMAGE_MIME_TYPES`. This is
    // what keeps it from drifting: a type the wire lets through that the engine
    // cannot send would be a 400 from someone else's API, and one the wire
    // refuses that the engine can send is a paste that silently fails.
    const engineTypes = [...new Set(Object.values(IMAGE_MIME_TYPES))].sort();
    for (const mimeType of engineTypes) {
      expect(validatePromptAttachment({ kind: "image", data: "AAAA", mimeType })).toMatchObject({
        ok: true,
      });
    }
    for (const mimeType of ["image/tiff", "image/svg+xml", "application/pdf", "text/plain"]) {
      expect(validatePromptAttachment({ kind: "image", data: "AAAA", mimeType })).toMatchObject({
        ok: false,
      });
    }
  });
});
