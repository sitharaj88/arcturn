/** Shared test helpers for building fake `ToolExecutionContext` instances. */

import { randomUUID } from "node:crypto";
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
