import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "./main.js";
import { version } from "./meta.js";
import { makeScratch, writeFileAt } from "./test-helpers/scratch.js";

let out: string[] = [];
let err: string[] = [];
const realStdout = process.stdout.write.bind(process.stdout);
const realStderr = process.stderr.write.bind(process.stderr);

beforeEach(() => {
  out = [];
  err = [];
  process.stdout.write = ((chunk: string) => {
    out.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => {
    err.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
});

afterEach(() => {
  process.stdout.write = realStdout;
  process.stderr.write = realStderr;
});

describe("main", () => {
  it("prints help and exits 0", async () => {
    expect(await main(["--help"])).toBe(0);
    expect(out.join("")).toContain("arcturn — the Arcturn coding agent");
    expect(err).toEqual([]);
  });

  it("prints the package version and exits 0", async () => {
    expect(await main(["--version"])).toBe(0);
    expect(out.join("")).toBe(`${version()}\n`);
  });

  it("prints the model catalog and exits 0", async () => {
    expect(await main(["--list-models"])).toBe(0);
    const text = out.join("");
    expect(text).toContain("Available models:");
    expect(text).toContain("anthropic/claude-sonnet-4-5");
  });

  it("includes models registered by an extension in --list-models", async () => {
    // Regression: --list-models printed the catalog before extensions loaded,
    // so a model that --model accepted was missing from the very list meant to
    // enumerate valid values.
    //
    // This runs the built CLI as a subprocess rather than calling main() in
    // process: extensions are loaded through jiti against the package's dist
    // build, which is a different module instance from the one vitest gives
    // this file, so an in-process check would look at the wrong catalog.
    const entry = fileURLToPath(new URL("../dist/main.js", import.meta.url));
    if (!existsSync(entry)) {
      // Nothing to assert against until `pnpm --filter arcturn build` runs.
      return;
    }

    const scratch = await makeScratch();
    await writeFileAt(
      join(scratch.home, ".arcturn", "extensions", "extra-model.ts"),
      `import { openaiCompatible } from "@arcturn/ai";
       export default function ext() {
         openaiCompatible("https://example.invalid/v1", "demo-model", {
           id: "demo/demo-model",
           displayName: "Demo Model",
           register: true,
         });
       }`,
    );

    const result = spawnSync(process.execPath, [entry, "--list-models", "--cwd", scratch.cwd], {
      encoding: "utf8",
      env: { ...process.env, ARCTURN_HOME: join(scratch.home, ".arcturn") },
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("demo/demo-model");
  });

  it("prints the provider catalog and exits 0", async () => {
    expect(await main(["--list-providers"])).toBe(0);
    const text = out.join("");
    expect(text).toContain("Registered providers");
    expect(text).toContain("Provider presets (use --model <preset>/<model>)");
    expect(text).toContain("GROQ_API_KEY");
    expect(text).toContain("Subscription (OAuth) sign-in");
  });

  it("includes the preset models in --list-models", async () => {
    expect(await main(["--list-models"])).toBe(0);
    expect(out.join("")).toContain("groq/llama-3.3-70b-versatile");
  });

  it("runs auth status against an isolated home", async () => {
    const scratch = await makeScratch();
    // `auth status` reads ~/.arcturn/auth; point ARCTURN_HOME at the scratch tree so the
    // test never sees a real credential.
    const previous = process.env.ARCTURN_HOME;
    process.env.ARCTURN_HOME = scratch.home;
    try {
      expect(await main(["auth", "status", "--cwd", scratch.cwd])).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.ARCTURN_HOME;
      else process.env.ARCTURN_HOME = previous;
    }
    const text = out.join("");
    expect(text).toContain("OAuth sign-in status");
    expect(text).toContain(join(scratch.home, "auth"));
    expect(text).toContain("signed out");
    expect(text).toContain("UNVERIFIED");
  });

  it("rejects an unknown auth provider with exit code 2", async () => {
    expect(await main(["auth", "login", "not-a-provider"])).toBe(2);
    expect(err.join("")).toContain('Unknown OAuth provider "not-a-provider"');
  });

  it("reports a usage error with exit code 2", async () => {
    expect(await main(["--nope"])).toBe(2);
    expect(err.join("")).toContain("Unknown option: --nope");
    expect(err.join("")).toContain('Run "arcturn --help" for usage.');
  });

  it("rejects --print without a prompt when stdin is a terminal", async () => {
    // main() reads process.stdin.isTTY through parseArgs; force the terminal
    // case so the assertion does not depend on how the tests are invoked.
    const previous = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    try {
      expect(await main(["-p"])).toBe(2);
      expect(err.join("")).toContain("needs a prompt");
    } finally {
      Object.defineProperty(process.stdin, "isTTY", { value: previous, configurable: true });
    }
  });

  it("reports an unusable model with exit code 2", async () => {
    expect(
      await main(["-p", "hello", "--model", "definitely/not-a-model", "--cwd", process.cwd()]),
    ).toBe(2);
    expect(err.join("")).toContain('Unknown model "definitely/not-a-model"');
  });
});

describe("peekUiMode", () => {
  it("defaults to screen so the boot banner never flashes before the alt-screen app", async () => {
    const { peekUiMode } = await import("./main.js");
    const scratch = await makeScratch();
    const previousHome = process.env.ARCTURN_HOME;
    process.env.ARCTURN_HOME = scratch.home;
    try {
      expect(await peekUiMode(scratch.cwd)).toBe("screen");
    } finally {
      if (previousHome === undefined) delete process.env.ARCTURN_HOME;
      else process.env.ARCTURN_HOME = previousHome;
    }
  });

  it("honours ARCTURN_UI, the project file, then the user file", async () => {
    const { peekUiMode } = await import("./main.js");
    const scratch = await makeScratch();
    const previousHome = process.env.ARCTURN_HOME;
    const previousUi = process.env.ARCTURN_UI;
    process.env.ARCTURN_HOME = scratch.home;
    try {
      await writeFileAt(join(scratch.home, "config.json"), JSON.stringify({ ui: "inline" }));
      expect(await peekUiMode(scratch.cwd)).toBe("inline");

      await writeFileAt(
        join(scratch.cwd, ".arcturn", "config.json"),
        JSON.stringify({ ui: "screen" }),
      );
      expect(await peekUiMode(scratch.cwd)).toBe("screen");

      process.env.ARCTURN_UI = "inline";
      expect(await peekUiMode(scratch.cwd)).toBe("inline");
    } finally {
      if (previousHome === undefined) delete process.env.ARCTURN_HOME;
      else process.env.ARCTURN_HOME = previousHome;
      if (previousUi === undefined) delete process.env.ARCTURN_UI;
      else process.env.ARCTURN_UI = previousUi;
    }
  });

  it("falls through malformed config files to the default", async () => {
    const { peekUiMode } = await import("./main.js");
    const scratch = await makeScratch();
    const previousHome = process.env.ARCTURN_HOME;
    process.env.ARCTURN_HOME = scratch.home;
    try {
      await writeFileAt(join(scratch.cwd, ".arcturn", "config.json"), "{not json");
      expect(await peekUiMode(scratch.cwd)).toBe("screen");
    } finally {
      if (previousHome === undefined) delete process.env.ARCTURN_HOME;
      else process.env.ARCTURN_HOME = previousHome;
    }
  });
});
