import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { cwdHash, resolveArcturnPaths } from "./paths.js";

describe("cwdHash", () => {
  it("is stable, short and relative-path independent", () => {
    const absolute = resolve("/tmp/project");
    expect(cwdHash(absolute)).toBe(cwdHash(absolute));
    expect(cwdHash(absolute)).toHaveLength(16);
    expect(cwdHash(absolute)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("separates different directories", () => {
    expect(cwdHash("/tmp/a")).not.toBe(cwdHash("/tmp/b"));
  });

  it("gives one directory one bucket where the filesystem folds case", () => {
    // `cd Project` and `cd project` are one directory on Windows and on a
    // stock macOS, so `--continue` has to find the same session history from
    // either spelling instead of quietly starting a second bucket beside it.
    expect(cwdHash("/tmp/Project", { caseInsensitive: true })).toBe(
      cwdHash("/tmp/project", { caseInsensitive: true }),
    );
  });

  it("gives one directory one bucket however the path is spelled", () => {
    // `path.isAbsolute("/work/repo")` is `true` on Windows while the path is
    // still only drive-relative, so hashing the raw spelling gave one directory
    // two buckets there — `arcturn --cwd /work/repo` and `arcturn` run from
    // `D:\work\repo` looked at different session histories. Every spelling
    // `resolve` settles onto one path has to settle onto one bucket, on either
    // separator, because both name the same directory on the platform that
    // accepts both.
    const settled = resolve("/work/repo");
    expect(cwdHash("/work/repo")).toBe(cwdHash(settled));
    expect(cwdHash(settled.replace(/\\/g, "/"))).toBe(cwdHash(settled));
    expect(cwdHash(`${settled}${sep}`)).toBe(cwdHash(settled));
    expect(cwdHash(join(settled, "sub", ".."))).toBe(cwdHash(settled));
  });

  it("keeps two buckets where the filesystem keeps two directories", () => {
    expect(cwdHash("/tmp/Project", { caseInsensitive: false })).not.toBe(
      cwdHash("/tmp/project", { caseInsensitive: false }),
    );
  });
});

describe("resolveArcturnPaths", () => {
  it("defaults to ~/.arcturn and <cwd>/.arcturn", () => {
    const paths = resolveArcturnPaths({ cwd: "/work/repo", env: {} });
    expect(paths.home).toBe(join(homedir(), ".arcturn"));
    expect(paths.userConfig).toBe(join(homedir(), ".arcturn", "config.json"));
    expect(paths.project).toBe(resolve("/work/repo/.arcturn"));
    expect(paths.projectConfig).toBe(resolve("/work/repo/.arcturn/config.json"));
  });

  it("honours ARCTURN_HOME and an explicit home override", () => {
    expect(resolveArcturnPaths({ cwd: "/w", env: { ARCTURN_HOME: "/custom" } }).home).toBe(
      resolve("/custom"),
    );
    expect(
      resolveArcturnPaths({ cwd: "/w", home: "/explicit", env: { ARCTURN_HOME: "/custom" } }).home,
    ).toBe(resolve("/explicit"));
  });

  it("buckets sessions under a hash of the working directory", () => {
    const paths = resolveArcturnPaths({ cwd: "/work/repo", home: "/h", env: {} });
    expect(paths.sessionsRoot).toBe(resolve("/h/sessions"));
    expect(paths.sessions).toBe(resolve("/h/sessions", cwdHash("/work/repo")));
    const other = resolveArcturnPaths({ cwd: "/work/other", home: "/h", env: {} });
    expect(other.sessions).not.toBe(paths.sessions);
  });

  it("puts OAuth credentials under the user root", () => {
    expect(resolveArcturnPaths({ cwd: "/work/repo", home: "/h", env: {} }).auth).toBe(
      resolve("/h/auth"),
    );
    expect(resolveArcturnPaths({ cwd: "/work/repo", env: {} }).auth).toBe(
      join(homedir(), ".arcturn", "auth"),
    );
  });

  it("resolves extension and mcp locations in both scopes", () => {
    const paths = resolveArcturnPaths({ cwd: "/work/repo", home: "/h", env: {} });
    expect(paths.userExtensions).toBe(resolve("/h/extensions"));
    expect(paths.projectExtensions).toBe(resolve("/work/repo/.arcturn/extensions"));
    expect(paths.userMcp).toBe(resolve("/h/mcp.json"));
    expect(paths.projectMcp).toBe(resolve("/work/repo/.arcturn/mcp.json"));
  });
});

describe("session bucket migration", () => {
  it("keeps using a legacy bucket that already holds history", async () => {
    // cwdHash started folding case when the filesystem does, which renames
    // every bucket made before that. A user opening an existing project must
    // not find --continue staring at an empty directory.
    const home = await mkdtemp(join(tmpdir(), "arcturn-bucket-"));
    const cwd = await mkdtemp(join(tmpdir(), "Arcturn-Project-"));
    const legacy = join(home, "sessions", cwdHash(cwd, { caseInsensitive: false }));
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, "s.jsonl"), "{}\n");

    const paths = resolveArcturnPaths({ cwd, home, env: {} });
    expect(paths.sessions).toBe(legacy);
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("uses the folded bucket for a project with no history", async () => {
    const home = await mkdtemp(join(tmpdir(), "arcturn-bucket-"));
    const cwd = await mkdtemp(join(tmpdir(), "Arcturn-Fresh-"));
    const paths = resolveArcturnPaths({ cwd, home, env: {} });
    expect(paths.sessions).toBe(join(home, "sessions", cwdHash(cwd)));
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });

  it("prefers the folded bucket when both exist", async () => {
    const home = await mkdtemp(join(tmpdir(), "arcturn-bucket-"));
    const cwd = await mkdtemp(join(tmpdir(), "Arcturn-Both-"));
    await mkdir(join(home, "sessions", cwdHash(cwd)), { recursive: true });
    await mkdir(join(home, "sessions", cwdHash(cwd, { caseInsensitive: false })), {
      recursive: true,
    });
    const paths = resolveArcturnPaths({ cwd, home, env: {} });
    expect(paths.sessions).toBe(join(home, "sessions", cwdHash(cwd)));
    await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  });
});
