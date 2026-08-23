/** Helpers for reading the tree structure encoded in a session's entries. */

import type { Message, SessionEntry, TodoItem } from "@arcturn/types";
import { text } from "../util/content.js";

/** One node of a materialized session tree. */
export interface SessionNode {
  entry: SessionEntry;
  children: SessionNode[];
}

/** A session tree built from a flat entry list. */
export interface SessionTree {
  /** Entries whose `parentId` is `null` or points outside the list. */
  roots: SessionNode[];
  /** Every node keyed by entry id. */
  byId: Map<string, SessionNode>;
}

/**
 * Build a tree from a flat, append-ordered entry list.
 *
 * Entries pointing at a missing parent become additional roots rather than
 * being dropped, so a truncated file still yields usable history.
 *
 * @param entries - Entries in append order.
 */
export function buildTree(entries: readonly SessionEntry[]): SessionTree {
  const byId = new Map<string, SessionNode>();
  for (const entry of entries) {
    byId.set(entry.id, { entry, children: [] });
  }
  const roots: SessionNode[] = [];
  for (const entry of entries) {
    const node = byId.get(entry.id)!;
    const parent = entry.parentId === null ? undefined : byId.get(entry.parentId);
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return { roots, byId };
}

/**
 * Walk `parentId` links from a leaf back to its root.
 *
 * @param entries - Entries in append order.
 * @param leafId - Id of the branch tip.
 * @returns Entries ordered root-first. Empty when `leafId` is unknown.
 */
export function pathToLeaf(entries: readonly SessionEntry[], leafId: string): SessionEntry[] {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const path: SessionEntry[] = [];
  const seen = new Set<string>();
  let current = byId.get(leafId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.push(current);
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  return path.reverse();
}

/**
 * Collect the tips of every branch, newest first.
 *
 * @param entries - Entries in append order.
 */
export function leafEntries(entries: readonly SessionEntry[]): SessionEntry[] {
  const withChildren = new Set<string>();
  for (const entry of entries) {
    if (entry.parentId !== null) withChildren.add(entry.parentId);
  }
  return entries
    .filter((entry) => !withChildren.has(entry.id))
    .sort((a, b) => b.timestamp - a.timestamp);
}

/**
 * The id of the most recently appended entry, i.e. the default branch tip.
 *
 * @param entries - Entries in append order.
 */
export function latestEntryId(entries: readonly SessionEntry[]): string | null {
  return entries.length === 0 ? null : entries[entries.length - 1]!.id;
}

/** Conversation plus agent state reconstructed from a branch. */
export interface MaterializedBranch {
  messages: Message[];
  todos: TodoItem[];
  plan: string | undefined;
  model: string | undefined;
  /** Id of the last entry on the branch, to continue appending from. */
  leafId: string | null;
}

/** Wrap a compaction summary in a stable, model-readable envelope. */
export function formatCompactionSummary(summary: string): string {
  return `<compacted-history>\n${summary}\n</compacted-history>`;
}

/**
 * Replay a branch into the conversation and state the agent should resume with.
 *
 * Compaction entries fold every message up to and including `upToId` into a
 * single synthetic user message carrying the summary.
 *
 * @param entries - Branch entries, root-first (e.g. from {@link pathToLeaf}).
 */
export function materializeBranch(entries: readonly SessionEntry[]): MaterializedBranch {
  let items: Array<{ id: string; message: Message }> = [];
  let todos: TodoItem[] = [];
  let plan: string | undefined;
  let model: string | undefined;

  for (const entry of entries) {
    switch (entry.kind) {
      case "message":
        items.push({ id: entry.id, message: entry.message });
        break;
      case "compaction": {
        const cutIndex = items.findIndex((item) => item.id === entry.upToId);
        const kept = cutIndex === -1 ? [] : items.slice(cutIndex + 1);
        items = [
          {
            id: entry.id,
            message: {
              role: "user",
              content: [text(formatCompactionSummary(entry.summary))],
              timestamp: entry.timestamp,
            },
          },
          ...kept,
        ];
        break;
      }
      case "state":
        if (entry.todos) todos = entry.todos;
        if (entry.plan !== undefined) plan = entry.plan;
        if (entry.model !== undefined) model = entry.model;
        break;
      case "label":
        break;
    }
  }

  return {
    messages: items.map((item) => item.message),
    todos,
    plan,
    model,
    leafId: entries.length === 0 ? null : entries[entries.length - 1]!.id,
  };
}
