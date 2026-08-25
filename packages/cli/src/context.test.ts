import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("reports a mention that escapes the workspace instead of skipping it silently", async () => {
    await writeFile(join(outside, "s.txt"), "OUTSIDE\n", "utf8");
    const result = await resolver.buildPrompt({
      cwd,
      text: `read @${join(outside, "s.txt")}`,
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

  it("refuses an attachment outside the workspace, fatally", async () => {
    await writeFile(join(outside, "s.txt"), "OUTSIDE\n", "utf8");
    await expect(
      resolver.buildPrompt({
        cwd,
        text: "look",
        attachments: [{ kind: "file", path: join(outside, "s.txt") }],
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

    const escaped = await resolver.resolve({ cwd, query: join(outside, "s.txt") });
    // The file really is there. The engine does not say so, because it did not
    // look — reporting `exists` for a path it refuses to read would make this
    // read-only verb a filesystem oracle for exactly the paths confinement
    // exists to hide.
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
