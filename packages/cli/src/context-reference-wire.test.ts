/**
 * A referenced file, end to end, asserted on **what the provider was sent**.
 *
 * A real {@link ArcturnRuntime}, a real {@link createServeHost}, a real
 * {@link ArcturnServer} on a real port, a real {@link createProtocolClient} —
 * and a scripted {@link LLMClient} standing in for the provider, kept so every
 * claim here can be made against the exact {@link LLMRequest} that would have
 * been serialized and billed.
 *
 * ## Why the assertions are on the request body and not on the call
 *
 * The bug this file exists for is a *cost* bug: the panel attached the file a
 * user merely had open as `{ kind: "file", path }`, the engine read it whole,
 * and 22k–81k tokens of a file nobody asked about went out on **every turn**.
 * Every observable thing about that prompt succeeded. A test asserting the
 * prompt resolved, or that the run emitted a `runEnd`, is green while the
 * bytes leave — which is exactly how the original "mentions never expanded on
 * the serve path" bug survived a green suite.
 *
 * So: `provider.requests[0]` is read, the user turn is flattened to text, and
 * the assertion is that a sentinel string *from inside the file* is **absent**
 * while the file's **path** is present. The same file attached explicitly with
 * `kind: "file"` must still carry the sentinel — a fix that turned every
 * attachment into a path would pass the first assertion and break the feature.
 */

import { join } from "node:path";
import { createProtocolClient } from "@arcturn/protocol";
import { ArcturnServer } from "@arcturn/server";
import type { LLMRequest, Message } from "@arcturn/types";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createContextResolver } from "./context.js";
import type { ArcturnRuntime } from "./runtime.js";
import { buildRuntime } from "./runtime.js";
import { createServeHost } from "./serve.js";
import { type FakeLLM, fakeLLM } from "./test-helpers/fake-llm.js";
import { makeScratch, type Scratch, writeFileAt } from "./test-helpers/scratch.js";

const servers: ArcturnServer[] = [];
const closers: (() => void)[] = [];
const runtimes: ArcturnRuntime[] = [];

afterEach(async () => {
  for (const close of closers.splice(0)) close();
  for (const server of servers.splice(0)) await server.stop();
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
});

/** A distinctive line that only ever exists *inside* the file on disk. */
const SENTINEL = "SENTINEL_ONLY_INSIDE_THE_FILE_CONTENTS";

interface Harness {
  client: ReturnType<typeof createProtocolClient>;
  sessionId: string;
  provider: FakeLLM;
  scratch: Scratch;
}

async function serve(): Promise<Harness> {
  const scratch = await makeScratch();
  const provider = fakeLLM([{ text: "done" }]);
  const runtime = await buildRuntime({
    cwd: scratch.cwd,
    home: scratch.home,
    env: scratch.env,
    llm: provider,
    extensions: false,
    skipRepoLookup: true,
  });
  runtimes.push(runtime);
  const server = new ArcturnServer({ sessionHost: createServeHost(runtime) });
  servers.push(server);
  const port = await server.start({ host: "127.0.0.1", port: 0 });
  const client = createProtocolClient(new WebSocket(`ws://127.0.0.1:${port}`));
  closers.push(() => client.close());
  const header = await client.createSession({ cwd: runtime.cwd });
  await client.openSession(header.sessionId);
  return { client, sessionId: header.sessionId, provider, scratch };
}

/** Every scrap of text in the request's user turns, concatenated. */
function userText(request: LLMRequest | undefined): string {
  if (request === undefined) return "";
  const messages: Message[] = request.messages;
  let out = "";
  for (const message of messages) {
    if (message.role !== "user") continue;
    for (const block of message.content) {
      if (block.type === "text") out += `${block.text}\n`;
    }
  }
  return out;
}

describe("a file the user merely has open reaches the provider as a path, not as bytes", () => {
  it("names the file and sends none of it", async () => {
    const harness = await serve();
    await writeFileAt(join(harness.scratch.cwd, "src", "big.ts"), `${SENTINEL}\n`.repeat(200));

    await harness.client.prompt(harness.sessionId, "what is this repo about?", [
      { kind: "fileReference", path: "src/big.ts" },
    ]);

    const sent = userText(harness.provider.requests[0]);
    // The assertion this whole file exists for: not one byte of the file.
    expect(sent).not.toContain(SENTINEL);
    // And it must not *look* like an excerpt either — a fenced block with a
    // path over it is what the model reads as "you were given this file".
    expect(sent).not.toContain("```");
    // But the model must know the file is there, or it cannot decide to read it.
    expect(sent).toContain("src/big.ts");
    expect(sent).toMatch(/read tool/);
  });

  it("still sends the contents when the same file is attached on purpose", async () => {
    const harness = await serve();
    await writeFileAt(join(harness.scratch.cwd, "src", "big.ts"), `${SENTINEL}\n`);

    await harness.client.prompt(harness.sessionId, "what changed here?", [
      { kind: "file", path: "src/big.ts" },
    ]);

    const sent = userText(harness.provider.requests[0]);
    expect(sent).toContain("src/big.ts (attached file):");
    expect(sent).toContain(SENTINEL);
  });

  it("still sends the excerpt when a selection names one", async () => {
    const harness = await serve();
    await writeFileAt(
      join(harness.scratch.cwd, "src", "big.ts"),
      ["one", "two", SENTINEL, "four"].join("\n"),
    );

    await harness.client.prompt(harness.sessionId, "explain this", [
      { kind: "file", path: "src/big.ts", range: { start: 3, end: 3 } },
    ]);

    const sent = userText(harness.provider.requests[0]);
    expect(sent).toContain(SENTINEL);
    expect(sent).not.toContain("four");
    expect(sent).toContain("excerpt, lines 3-3 of 4");
  });

  it("refuses a reference that escapes the workspace, rather than naming it anyway", async () => {
    const harness = await serve();
    await expect(
      harness.client.prompt(harness.sessionId, "look", [
        { kind: "fileReference", path: "../../etc/passwd" },
      ]),
    ).rejects.toThrow(/outside the workspace/);
    expect(harness.provider.requests).toHaveLength(0);
  });

  it("refuses a reference to something that is not a file", async () => {
    const harness = await serve();
    await expect(
      harness.client.prompt(harness.sessionId, "look", [{ kind: "fileReference", path: "." }]),
    ).rejects.toThrow(/is not a file/);
    expect(harness.provider.requests).toHaveLength(0);
  });
});

describe("the resolver alone, on the same file, at both spellings", () => {
  it("charges a reference the length of one line and an attachment the whole file", async () => {
    const scratch = await makeScratch();
    await writeFileAt(join(scratch.cwd, "src", "big.ts"), `${SENTINEL}\n`.repeat(200));
    const resolver = createContextResolver();

    const referenced = await resolver.buildPrompt({
      cwd: scratch.cwd,
      text: "hi",
      attachments: [{ kind: "fileReference", path: "src/big.ts" }],
    });
    const attached = await resolver.buildPrompt({
      cwd: scratch.cwd,
      text: "hi",
      attachments: [{ kind: "file", path: "src/big.ts" }],
    });

    // The number is the point. Two orders of magnitude, on the same file.
    expect(referenced.text.length).toBeLessThan(300);
    expect(attached.text.length).toBeGreaterThan(7000);
    expect(referenced.text).not.toContain(SENTINEL);
  });

  it("still refuses a reference over the total budget's own accounting", async () => {
    // A reference costs the sentence, not the file: a budget of 4 KiB fits
    // hundreds of them, where four of these files would not fit at all.
    const scratch = await makeScratch();
    for (let i = 0; i < 8; i++) {
      await writeFileAt(join(scratch.cwd, `f${String(i)}.ts`), `${SENTINEL}\n`.repeat(200));
    }
    const capped = createContextResolver({ maxAttachmentBytes: 4096 });
    const references = Array.from({ length: 8 }, (_, i) => ({
      kind: "fileReference" as const,
      path: `f${String(i)}.ts`,
    }));
    await expect(
      capped.buildPrompt({ cwd: scratch.cwd, text: "hi", attachments: references }),
    ).resolves.toBeDefined();
    await expect(
      capped.buildPrompt({
        cwd: scratch.cwd,
        text: "hi",
        attachments: [{ kind: "file", path: "f0.ts" }],
      }),
    ).rejects.toThrow(/attachment budget/);
  });
});

describe("an explicit attachment is never silently downgraded to a reference", () => {
  /**
   * The decision, recorded as a test rather than as a paragraph.
   *
   * A very large `@` file could have been turned into a reference past some
   * size, and it deliberately is not. The user *asked* for that file; quietly
   * handing the model a path instead is the same species of dishonesty as
   * quietly handing it 81k tokens nobody asked for, pointed the other way, and
   * it would make one `@src/big.ts` mean two different things on two different
   * days as the file grew. The honest mechanism for "too big" already exists
   * and already reports itself: a truncation marker, or a refusal with the
   * number in it.
   */
  it("truncates a long file and says so, rather than replacing it with its name", async () => {
    const scratch = await makeScratch();
    // Past the 2000-line inline cap, well under the 2 MiB per-file ceiling.
    await writeFileAt(join(scratch.cwd, "long.ts"), `${SENTINEL}\n`.repeat(3000));
    const result = await createContextResolver().buildPrompt({
      cwd: scratch.cwd,
      text: "review",
      attachments: [{ kind: "file", path: "long.ts" }],
    });
    expect(result.text).toContain("long.ts (attached file):");
    expect(result.text).toContain(SENTINEL);
    expect(result.text).toContain("… truncated (2000 line / 200KB cap)");
    expect(result.text).not.toContain("referenced file");
  });

  it("refuses a file past the per-file ceiling with both numbers, and reads none of it", async () => {
    const scratch = await makeScratch();
    // 2 MiB + 1 byte: `MAX_TEXT_FILE_BYTES` is checked from the stat, so this
    // never gets buffered.
    await writeFileAt(join(scratch.cwd, "huge.ts"), "x".repeat(2 * 1024 * 1024 + 1));
    await expect(
      createContextResolver().buildPrompt({
        cwd: scratch.cwd,
        text: "review",
        attachments: [{ kind: "file", path: "huge.ts" }],
      }),
    ).rejects.toThrow(/2097153 bytes, past this engine's 2097152-byte ceiling/);
  });

  it("still binds the 1 MiB total budget, and names what did not fit", async () => {
    // Six files that each truncate to the 200 KiB inline cap: five fit inside
    // `PROMPT_ATTACHMENT_MAX_BYTES` and the sixth does not. The budget is
    // charged from what was *read*, so this is the real default binding on
    // real bytes rather than an injected number.
    const scratch = await makeScratch();
    const names = Array.from({ length: 6 }, (_, i) => `f${String(i)}.ts`);
    for (const name of names) await writeFileAt(join(scratch.cwd, name), "x".repeat(250 * 1024));
    await expect(
      createContextResolver().buildPrompt({
        cwd: scratch.cwd,
        text: "review",
        attachments: names.map((path) => ({ kind: "file" as const, path })),
      }),
    ).rejects.toThrow(/f5\.ts does not fit.*1048576-byte total attachment budget/s);
  });
});
