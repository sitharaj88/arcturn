/**
 * The in-panel session list, driven as functions.
 *
 * Same technique as `webview-models.test.ts`: `SESSION_LIST_SOURCE` is the
 * text the webview runs, compiled here so these tests exercise the shipped
 * bytes. Everything under test is pure — a list of headers in, an ordering or
 * a sentence out — so there is no DOM and no `vscode`.
 */

import { describe, expect, it } from "vitest";
import { SESSION_LIST_SOURCE, type SessionOption } from "./webview-sessions.js";

const api = new Function(
  `${SESSION_LIST_SOURCE}\nreturn { orderSessions, filterSessions, sessionLabel, sessionMeta, formatAge };`,
)() as {
  orderSessions: (sessions: SessionOption[]) => SessionOption[];
  filterSessions: (sessions: SessionOption[], query: string) => SessionOption[];
  sessionLabel: (session: SessionOption) => string;
  sessionMeta: (session: SessionOption, now: number) => string;
  formatAge: (createdAt: number, now: number) => string;
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = 1_700_000_000_000;

function session(over: Partial<SessionOption> & { sessionId: string }): SessionOption {
  return { title: "", createdAt: NOW - HOUR, ...over };
}

describe("orderSessions", () => {
  it("puts the session a user was in most recently at the top", () => {
    const ordered = api.orderSessions([
      session({ sessionId: "old", createdAt: NOW - 3 * DAY }),
      session({ sessionId: "new", createdAt: NOW - MINUTE }),
      session({ sessionId: "mid", createdAt: NOW - DAY }),
    ]);
    expect(ordered.map((entry) => entry.sessionId)).toEqual(["new", "mid", "old"]);
  });

  it("breaks a tie on the id, so the order never depends on the engine's", () => {
    const ordered = api.orderSessions([
      session({ sessionId: "01B", createdAt: NOW }),
      session({ sessionId: "01A", createdAt: NOW }),
    ]);
    expect(ordered.map((entry) => entry.sessionId)).toEqual(["01B", "01A"]);
  });

  it("does not reorder the caller's array", () => {
    const input = [
      session({ sessionId: "a", createdAt: NOW - DAY }),
      session({ sessionId: "b", createdAt: NOW }),
    ];
    api.orderSessions(input);
    expect(input.map((entry) => entry.sessionId)).toEqual(["a", "b"]);
  });
});

describe("filterSessions", () => {
  const sessions = [
    session({ sessionId: "01JAAAA", title: "Rebuild the sidebar" }),
    session({ sessionId: "01JBBBB", title: "Fix the setModel bug" }),
  ];

  it("returns everything for an empty query", () => {
    expect(api.filterSessions(sessions, "")).toHaveLength(2);
    expect(api.filterSessions(sessions, "   ")).toHaveLength(2);
  });

  it("matches the title and the id, case-insensitively", () => {
    expect(api.filterSessions(sessions, "sidebar").map((entry) => entry.sessionId)).toEqual([
      "01JAAAA",
    ]);
    expect(api.filterSessions(sessions, "01jbbbb").map((entry) => entry.sessionId)).toEqual([
      "01JBBBB",
    ]);
  });

  it("requires every token to match, so a second word narrows instead of widening", () => {
    expect(api.filterSessions(sessions, "the bug").map((entry) => entry.sessionId)).toEqual([
      "01JBBBB",
    ]);
    expect(api.filterSessions(sessions, "sidebar bug")).toEqual([]);
  });
});

describe("sessionLabel", () => {
  it("uses the title the engine stored", () => {
    expect(api.sessionLabel(session({ sessionId: "s1", title: "Rebuild the sidebar" }))).toBe(
      "Rebuild the sidebar",
    );
  });

  it("says a session is untitled rather than printing its id twice", () => {
    // The id is already the row's second line; repeating it as the headline
    // makes two identical strings and names nothing.
    expect(api.sessionLabel(session({ sessionId: "01JAAAA", title: "" }))).toBe("Untitled session");
  });
});

describe("formatAge", () => {
  it("counts up through the units a person actually uses", () => {
    expect(api.formatAge(NOW - 5_000, NOW)).toBe("just now");
    expect(api.formatAge(NOW - 5 * MINUTE, NOW)).toBe("5m ago");
    expect(api.formatAge(NOW - 3 * HOUR, NOW)).toBe("3h ago");
    expect(api.formatAge(NOW - 2 * DAY, NOW)).toBe("2d ago");
    expect(api.formatAge(NOW - 10 * DAY, NOW)).toBe("1w ago");
    expect(api.formatAge(NOW - 60 * DAY, NOW)).toBe("2mo ago");
    expect(api.formatAge(NOW - 400 * DAY, NOW)).toBe("1y ago");
  });

  it("says nothing rather than 1970 when the header carried no timestamp", () => {
    expect(api.formatAge(0, NOW)).toBe("");
    expect(api.formatAge(Number.NaN, NOW)).toBe("");
  });

  it("does not print a negative age when the clocks disagree", () => {
    expect(api.formatAge(NOW + HOUR, NOW)).toBe("just now");
  });
});

describe("sessionMeta", () => {
  it("prints the id and how long ago it was started", () => {
    expect(api.sessionMeta(session({ sessionId: "01JAAAA", createdAt: NOW - 3 * HOUR }), NOW)).toBe(
      "01JAAAA · 3h ago",
    );
  });

  it("drops the separator rather than trailing one when there is no timestamp", () => {
    expect(api.sessionMeta(session({ sessionId: "01JAAAA", createdAt: 0 }), NOW)).toBe("01JAAAA");
  });
});
