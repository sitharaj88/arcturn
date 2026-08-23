/**
 * Shared test scaffolding: temporary repositories on disk and a fake
 * {@link ToolExecutionContext}. Excluded from the published build by
 * `tsconfig.json`.
 *
 * Every helper here works on a real `fs.mkdtemp` directory and makes zero
 * network calls, which is the whole test contract for this package.
 */

import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ToolExecutionContext, ToolUpdate } from "@arcturn/types";

/** A temporary repository root plus the helpers to fill and remove it. */
export interface TempRepo {
  /** Absolute path of the repository root. */
  root: string;
  /** Write files, creating parent directories. Keys are repo-relative POSIX paths. */
  write(files: Record<string, string>): Promise<void>;
  /** Remove the whole tree. */
  cleanup(): Promise<void>;
}

/** Create an empty temporary repository, optionally seeded with files. */
export async function createTempRepo(files: Record<string, string> = {}): Promise<TempRepo> {
  const root = await mkdtemp(join(tmpdir(), "arcturn-index-"));
  const repo: TempRepo = {
    root,
    async write(next) {
      for (const [relative, contents] of Object.entries(next)) {
        const absolute = join(root, relative);
        await mkdir(dirname(absolute), { recursive: true });
        await writeFile(absolute, contents, "utf8");
      }
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };
  await repo.write(files);
  return repo;
}

/** A directory to persist an index into, removed by {@link TempRepo.cleanup}. */
export async function createTempIndexDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "arcturn-index-store-"));
}

/** A `ToolExecutionContext` for tests: always allows permission, records updates. */
export function createFakeContext(cwd: string, signal?: AbortSignal): ToolExecutionContext {
  const updates: ToolUpdate[] = [];
  return {
    cwd,
    signal: signal ?? new AbortController().signal,
    sessionId: "test-session",
    toolCallId: randomUUID(),
    onUpdate: (update) => {
      updates.push(update);
    },
    requestPermission: async () => ({ requestId: "test", behavior: "allow" }),
  };
}

/** The text of a tool result, for assertions. */
export function resultText(result: { content: Array<{ type: string }> }): string {
  const first = result.content[0];
  if (first?.type !== "text") return "";
  return (first as { text: string }).text;
}
