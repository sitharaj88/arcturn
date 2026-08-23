import { existsSync } from "node:fs";
import { dirname, join, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { displayPath, resolvePath, toPosixSeparators } from "./path-utils.js";

describe("toPosixSeparators", () => {
  // Both branches are asserted from whichever OS runs the suite, by passing
  // the separator explicitly. A test that only exercises its own host's
  // separator is the reason the Windows behaviour went unnoticed until CI
  // first ran on Windows.
  it("rewrites every separator when the platform separator is a backslash", () => {
    expect(toPosixSeparators(String.raw`src\a.ts`, "\\")).toBe("src/a.ts");
    expect(toPosixSeparators(String.raw`src\deep\nested\a.ts`, "\\")).toBe("src/deep/nested/a.ts");
    expect(toPosixSeparators(String.raw`C:\repo\src\a.ts`, "\\")).toBe("C:/repo/src/a.ts");
  });

  it("leaves an already-POSIX path alone under either separator", () => {
    expect(toPosixSeparators("src/a.ts", "\\")).toBe("src/a.ts");
    expect(toPosixSeparators("src/a.ts", "/")).toBe("src/a.ts");
  });

  it("keeps a literal backslash where the platform separator is a slash", () => {
    // On POSIX a backslash is an ordinary, legal character in a filename, so
    // rewriting it would rename the file rather than reformat the path — the
    // resulting string would name something that does not exist.
    expect(toPosixSeparators(String.raw`weird\name.ts`, "/")).toBe(String.raw`weird\name.ts`);
  });

  it("defaults to this platform's separator", () => {
    expect(toPosixSeparators(join("src", "a.ts"))).toBe("src/a.ts");
    expect(toPosixSeparators(win32.join("src", "a.ts"), win32.sep)).toBe("src/a.ts");
  });
});

describe("displayPath", () => {
  // This source directory, not `process.cwd()`: vitest runs from the repo
  // root, and the round-trip case below needs a real file to point at.
  const cwd = dirname(fileURLToPath(import.meta.url));

  it("renders a path under cwd relative and forward-slashed on every platform", () => {
    expect(displayPath(cwd, join(cwd, "src", "a.ts"))).toBe("src/a.ts");
  });

  it("round-trips: what the model is shown resolves back to the same file", () => {
    // The whole point of the `/` spelling. `resolvePath` is what every tool
    // runs a model-supplied path through, and win32 treats `/` and `\` as
    // interchangeable, so the rendered form has to come back to byte-identical
    // input on both platforms.
    const target = join(cwd, "path-utils.ts");
    expect(existsSync(target)).toBe(true);
    expect(resolvePath(cwd, displayPath(cwd, target))).toBe(target);
  });

  it("falls back to the absolute path when the target is cwd itself", () => {
    expect(displayPath(cwd, cwd)).toBe(toPosixSeparators(cwd, sep));
  });

  it("keeps an escaping path absolute rather than emitting a relative ladder it cannot render", () => {
    const parent = join(cwd, "..");
    // `relative` would answer ".."; either way it must never come back with a
    // backslash separator for the model to re-encode into JSON.
    expect(displayPath(cwd, parent)).not.toContain("\\");
  });
});
