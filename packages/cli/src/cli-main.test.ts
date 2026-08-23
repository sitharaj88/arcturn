/**
 * `runServeCommand`'s non-loopback warning, added alongside the
 * remote-session hardening work. `runServeCommand` itself needs a live
 * runtime and real sockets to exercise end to end, so the decision it makes
 * — warn or not, based on the bound host — is pulled out as the pure
 * `nonLoopbackWarning` and tested directly here. `runCli`'s other branches
 * (interactive TUI, `--print`, `mcp`, `acp`, ...) are exercised elsewhere.
 *
 * `readPipedStdin` is here for the same reason: the decision it makes — block
 * for stdin, or run the prompt that was asked for — is what a `--print` run
 * hangs on when it gets it wrong, and a live `process.stdin` cannot be made to
 * stay open on demand inside a test.
 */

import { describe, expect, it } from "vitest";
import { nonLoopbackWarning, readPipedStdin, type StdinLike } from "./cli-main.js";
import { isLoopbackHost } from "./serve.js";

describe("nonLoopbackWarning", () => {
  it("warns for a non-loopback host", () => {
    const warning = nonLoopbackWarning("0.0.0.0", isLoopbackHost);
    expect(warning).toMatch(/non-loopback interface/);
    expect(warning).toMatch(/full tool execution as your user/);
  });

  it("warns for a concrete LAN address", () => {
    expect(nonLoopbackWarning("192.168.1.5", isLoopbackHost)).toBeDefined();
  });

  it("does not warn for the loopback addresses arcturn serve recognizes", () => {
    expect(nonLoopbackWarning("127.0.0.1", isLoopbackHost)).toBeUndefined();
    expect(nonLoopbackWarning("localhost", isLoopbackHost)).toBeUndefined();
    expect(nonLoopbackWarning("::1", isLoopbackHost)).toBeUndefined();
  });
});

describe("readPipedStdin", () => {
  /** A pipe that yields `chunks`, then ends — `cat file | arcturn -p`. */
  function closing(...chunks: string[]): StdinLike {
    return {
      isTTY: false,
      async *[Symbol.asyncIterator]() {
        for (const chunk of chunks) yield chunk;
      },
    };
  }

  /**
   * A pipe that never yields and never ends — what a parent process leaves on
   * a child's stdin. Reading this to EOF is the hang; the `never` promise is
   * the honest model of it, so a regression re-introduces a real timeout
   * rather than a fast wrong answer.
   */
  function open(): StdinLike {
    return {
      isTTY: false,
      [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }),
    };
  }

  it("does not block on an inherited pipe when a prompt argument was given", async () => {
    // The regression: `arcturn -p "..." --output-format json` from CI, a
    // Makefile or any spawn() produced nothing at all, forever, because
    // `isTTY === false` was read as "someone is piping me a prompt".
    expect(await readPipedStdin(open(), true, 20)).toBe("");
  });

  it("releases the abandoned pipe so the process can still exit", async () => {
    // The first fix for this bug completed the run and then hung at exit: the
    // `next()` it walked away from still held stdin's handle open. Finishing
    // the work and never exiting is the same bug wearing a different hat.
    let closed = false;
    let unreffed = false;
    const stdin: StdinLike = {
      isTTY: false,
      unref: () => {
        unreffed = true;
      },
      [Symbol.asyncIterator]: () => ({
        next: () => new Promise<never>(() => {}),
        return: async () => {
          closed = true;
          return { done: true as const, value: undefined };
        },
      }),
    };
    expect(await readPipedStdin(stdin, true, 20)).toBe("");
    expect(closed, "iterator closed").toBe(true);
    expect(unreffed, "stdin unref'd").toBe(true);
  });

  it("still reads a real pipe to EOF when a prompt argument was given", async () => {
    // The grace period must not cost `cat ctx.txt | arcturn -p "summarise"`
    // its context: a first byte arrives, so the writer is really feeding us.
    expect(await readPipedStdin(closing("hello ", "world"), true, 20)).toBe("hello world");
  });

  it("blocks to EOF when stdin IS the prompt", async () => {
    // No prompt argument means `arcturn -p < q.txt`, where waiting is the only
    // correct behaviour — there is nothing else to run.
    expect(await readPipedStdin(closing("the whole prompt"), false, 20)).toBe("the whole prompt");
  });

  it("reads nothing from a terminal", async () => {
    const tty: StdinLike = {
      isTTY: true,
      [Symbol.asyncIterator]: () => ({ next: () => new Promise<never>(() => {}) }),
    };
    expect(await readPipedStdin(tty, false, 20)).toBe("");
  });
});
