/** Shared test helpers for building fake `ToolExecutionContext` instances. */

import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import type {
  PermissionDecision,
  PermissionRequest,
  ToolExecutionContext,
  ToolUpdate,
} from "@arcturn/types";

export interface FakeContextOptions {
  cwd: string;
  signal?: AbortSignal;
  /** Called for every requestPermission invocation; defaults to always-allow. */
  onPermissionRequest?: (
    request: Omit<PermissionRequest, "id">,
  ) => PermissionDecision | Promise<PermissionDecision>;
}

export interface FakeContext {
  ctx: ToolExecutionContext;
  updates: ToolUpdate[];
  permissionRequests: Array<Omit<PermissionRequest, "id">>;
}

/** Build a `ToolExecutionContext` for tests, recording permission requests and onUpdate calls. */
export function createFakeContext(options: FakeContextOptions): FakeContext {
  const updates: ToolUpdate[] = [];
  const permissionRequests: Array<Omit<PermissionRequest, "id">> = [];

  const ctx: ToolExecutionContext = {
    cwd: options.cwd,
    signal: options.signal ?? new AbortController().signal,
    sessionId: "test-session",
    toolCallId: randomUUID(),
    onUpdate: (update) => {
      updates.push(update);
    },
    requestPermission: async (request) => {
      permissionRequests.push(request);
      if (options.onPermissionRequest) {
        return options.onPermissionRequest(request);
      }
      return { requestId: "test", behavior: "allow" };
    },
  };

  return { ctx, updates, permissionRequests };
}

/** A requestPermission stub that always denies, optionally with a message. */
export function denyAllPermissions(message?: string) {
  return (): PermissionDecision => ({ requestId: "test", behavior: "deny", message });
}

/**
 * Delete a temp directory a test spawned processes into.
 *
 * POSIX unlinks a path regardless of who still holds it open, so a plain
 * `rm(dir, { recursive: true, force: true })` in an `afterEach` always
 * succeeds there. Windows refuses to remove a directory any handle is open
 * on, and a child process's *working directory* is exactly such a handle,
 * held until that process is fully reaped by the OS. A suite that spawns into
 * its temp dir therefore races its own teardown on Windows and fails the test
 * it already passed with `EBUSY`/`EPERM` on a directory it no longer cares
 * about.
 *
 * `fs.rm` already has the retry loop for this — `maxRetries`/`retryDelay`
 * back off linearly on `EBUSY`, `EPERM`, `ENOTEMPTY` and friends — it is just
 * off by default. This is teardown hygiene, not a weakened assertion: the
 * test's own expectations have all run by the time it is called.
 */
export async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
