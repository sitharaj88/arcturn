import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import type { CommandUi, SelectOption } from "./commands.js";
import {
  createRegistryCommands,
  formatInstallSummary,
  formatPackageList,
  formatRemoveSummary,
  formatUpdateReport,
  type InstallResult,
  installPackage,
  isValidPackageName,
  listPackages,
  RegistryError,
  type RegistryPaths,
  registryPathsFromHome,
  removePackage,
  resolvePackageDir,
  resolveSource,
  updateAllPackages,
  updatePackage,
} from "./registry.js";
import { buildTestRuntime, makeScratch } from "./test-helpers/scratch.js";

const execFileAsync = promisify(execFile);

/* Cleanup ------------------------------------------------------------------- */

const cleanupDirs: string[] = [];

afterEach(async () => {
  await Promise.all(cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function scratchDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

/* git fixture helpers --------------------------------------------------------- */

async function gitRun(args: string[], cwd: string): Promise<void> {
  await execFileAsync("git", args, { cwd });
}

async function gitHead(cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd });
  return stdout.trim();
}

async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(root, rel);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
  }
}

/**
 * Create a throwaway local git repository with the given files, committed.
 *
 * The URL comes from {@link pathToFileURL} rather than `file://${dir}`: on
 * Windows that concatenation produces `file://C:\Users\...`, where everything
 * after `file://` up to the first `/` reads as the *host* — so git is handed a
 * URL with a host and no path. The canonical spelling is `file:///C:/Users/...`,
 * which is what `pathToFileURL` produces, and on POSIX it is byte-identical to
 * what the concatenation produced.
 *
 * `core.autocrlf false` for the same reason the repository root ships a
 * `.gitattributes`: Git for Windows defaults it to `true`, which would hand
 * every checkout of these fixtures back with CRLF endings the fixture text
 * never had.
 */
async function makeGitRepo(files: Record<string, string>): Promise<{ dir: string; url: string }> {
  const dir = await scratchDir("arcturn-registry-src-");
  await gitRun(["init", "--quiet", "-b", "main"], dir);
  await gitRun(["config", "user.email", "test@example.com"], dir);
  await gitRun(["config", "user.name", "Test"], dir);
  await gitRun(["config", "core.autocrlf", "false"], dir);
  await writeFiles(dir, files);
  await gitRun(["add", "-A"], dir);
  await gitRun(["commit", "--quiet", "-m", "init"], dir);
  return { dir, url: pathToFileURL(dir).href };
}

async function commitAll(dir: string, message: string): Promise<string> {
  await gitRun(["add", "-A"], dir);
  await gitRun(["commit", "--quiet", "-m", message], dir);
  return gitHead(dir);
}

/** Isolated `RegistryPaths` rooted at a throwaway `~/.arcturn`-shaped directory. */
async function makeRegistry(): Promise<RegistryPaths> {
  const home = await scratchDir("arcturn-registry-home-");
  return registryPathsFromHome(home);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function isSymlink(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch {
    return false;
  }
}

const approve = () => true;
const decline = () => false;

/* resolveSource ---------------------------------------------------------------- */

describe("resolveSource", () => {
  it("rejects empty input", () => {
    expect(() => resolveSource("")).toThrow(RegistryError);
    expect(() => resolveSource("   ")).toThrow(RegistryError);
  });

  it("rejects malformed shorthand", () => {
    expect(() => resolveSource("owner/")).toThrow(RegistryError);
    expect(() => resolveSource("just-one-segment")).toThrow(RegistryError);
    expect(() => resolveSource("-rf")).toThrow(RegistryError);
  });

  it("rejects a traversal attempt inside a GitHub shorthand subdir", () => {
    expect(() => resolveSource("owner/repo/../secrets")).toThrow(RegistryError);
    expect(() => resolveSource("owner/repo/skills/../../etc")).toThrow(RegistryError);
  });

  it("parses a plain https git URL, with and without a pinned ref", () => {
    const noRef = resolveSource("https://example.com/foo/bar.git");
    expect(noRef).toMatchObject({
      kind: "git-url",
      location: "https://example.com/foo/bar.git",
      ref: undefined,
      defaultName: "bar",
    });

    const pinned = resolveSource("https://example.com/foo/bar.git@v2.0.0");
    expect(pinned).toMatchObject({
      kind: "git-url",
      location: "https://example.com/foo/bar.git",
      ref: "v2.0.0",
      defaultName: "bar",
    });
  });

  it("leaves an scp-style address's user-info untouched", () => {
    const resolved = resolveSource("git@github.com:owner/repo.git");
    expect(resolved).toMatchObject({
      kind: "git-url",
      location: "git@github.com:owner/repo.git",
      ref: undefined,
      defaultName: "repo",
    });
  });

  it("splits a ref off the final segment of an scp-style address", () => {
    const resolved = resolveSource("git@github.com:owner/repo.git@v1.0");
    expect(resolved).toMatchObject({
      kind: "git-url",
      location: "git@github.com:owner/repo.git",
      ref: "v1.0",
    });
  });

  it("resolves a GitHub owner/repo shorthand", () => {
    const resolved = resolveSource("sitharaj88/arcturn-skills");
    expect(resolved).toMatchObject({
      kind: "github-shorthand",
      location: "https://github.com/sitharaj88/arcturn-skills.git",
      ref: undefined,
      subdir: undefined,
      defaultName: "arcturn-skills",
    });
  });

  it("resolves a GitHub shorthand with a pinned ref", () => {
    const resolved = resolveSource("sitharaj88/arcturn-skills@v1.2.3");
    expect(resolved.ref).toBe("v1.2.3");
    expect(resolved.location).toBe("https://github.com/sitharaj88/arcturn-skills.git");
  });

  it("resolves a GitHub shorthand with a subdirectory and a ref", () => {
    const resolved = resolveSource("sitharaj88/arcturn-skills/skills/greeter@main");
    expect(resolved).toMatchObject({
      kind: "github-shorthand",
      subdir: "skills/greeter",
      ref: "main",
      defaultName: "greeter",
    });
  });

  // A `local-path` source is `resolve`d, so its location is spelled the way the
  // running platform spells an absolute path: `/abs/path/pkg` on POSIX and
  // `D:\abs\path\pkg` on Windows, where a leading-slash path is rooted on the
  // current drive. The assertions below therefore resolve the expectation the
  // same way instead of hard-coding the POSIX spelling — what is under test is
  // that the source is recognised and anchored, not which separator it lands on.

  it("resolves an absolute local path", () => {
    const resolved = resolveSource("/abs/path/pkg");
    expect(resolved).toMatchObject({
      kind: "local-path",
      location: resolve("/abs/path/pkg"),
      defaultName: "pkg",
    });
  });

  it("resolves a relative local path against the given cwd", () => {
    const resolved = resolveSource("./my-pkg", { cwd: "/base/dir" });
    expect(resolved.kind).toBe("local-path");
    expect(resolved.location).toBe(resolve("/base/dir", "my-pkg"));
  });

  it("recognises the Windows spellings of a local path instead of rejecting them", () => {
    // `.\my-pkg` is what tab-completion in `cmd` and PowerShell produces, and
    // `C:\pkgs\my-pkg` is what an absolute path looks like there. None of these
    // starts with `/`, `./`, `../` or `~`, so every one fell through to the
    // git-URL and `owner/repo` shapes, matched neither, and came back as
    // `could not parse package source` — on Windows, `arcturn ext install`
    // could not be handed a local package by the spelling its own shell
    // completes. Recognition is asserted on both platforms; where each spelling
    // *lands* is `path.resolve`'s business and differs by design, so what is
    // pinned here is that it is recognised, anchored absolutely, and named
    // after its leaf however that leaf is spelled.
    const options = { cwd: "/base/dir", homeDir: "/home/alice" };
    for (const raw of [
      ".\\my-pkg",
      "..\\my-pkg",
      "C:\\pkgs\\my-pkg",
      "C:/pkgs/my-pkg",
      "\\\\server\\share\\my-pkg",
      "~\\pkgs\\my-pkg",
    ]) {
      const resolvedSource = resolveSource(raw, options);
      expect(resolvedSource.kind, raw).toBe("local-path");
      expect(resolvedSource.defaultName, raw).toBe("my-pkg");
      expect(isAbsolute(resolvedSource.location), raw).toBe(true);
      expect(resolvedSource.ref, raw).toBeUndefined();
    }
  });

  it("still reads a one-letter URL scheme as a URL, not a drive", () => {
    // The drive-letter shape is `X:` followed by one separator; `x://host/p` is
    // a scheme and keeps its own branch.
    expect(resolveSource("s://host/repo.git").kind).toBe("git-url");
  });

  it("expands ~ against the given home directory", () => {
    const resolved = resolveSource("~/pkgs/my-pkg", { homeDir: "/home/alice" });
    expect(resolved.location).toBe(resolve("/home/alice", "pkgs", "my-pkg"));
  });

  it("never treats a local path's trailing text as a ref", () => {
    const resolved = resolveSource("/abs/path/pkg@2");
    expect(resolved.kind).toBe("local-path");
    expect(resolved.location).toBe(resolve("/abs/path/pkg@2"));
    expect(resolved.ref).toBeUndefined();
  });

  it("recognises a file:// URL as a git source, not a local path", () => {
    const resolved = resolveSource("file:///tmp/some-repo");
    expect(resolved.kind).toBe("git-url");
    expect(resolved.location).toBe("file:///tmp/some-repo");
  });
});

/* Package name validation -------------------------------------------------------- */

describe("isValidPackageName / resolvePackageDir", () => {
  it("accepts names using only the allowed charset", () => {
    expect(isValidPackageName("my-pkg_1.0")).toBe(true);
    expect(isValidPackageName("simple")).toBe(true);
  });

  it("rejects uppercase, slashes, and traversal segments", () => {
    expect(isValidPackageName("MyPkg")).toBe(false);
    expect(isValidPackageName("a/b")).toBe(false);
    expect(isValidPackageName("a\\b")).toBe(false);
    expect(isValidPackageName("../../evil")).toBe(false);
    expect(isValidPackageName(".")).toBe(false);
    expect(isValidPackageName("..")).toBe(false);
  });

  it("rejects a name Win32 would settle onto the packages root itself", () => {
    // `...` passes the charset and is neither `.` nor `..`, and Windows
    // discards a component's trailing dots before the filesystem sees the
    // name — so `<packagesRoot>\...` *is* `<packagesRoot>`, while the
    // containment check below compares the lexical spelling where the dots are
    // still there. Installing under that name would unpack over the root of the
    // package store and removing it would delete the store, every other
    // installed package with it.
    for (const name of ["...", "....", "foo.", ".foo"]) {
      expect(isValidPackageName(name), name).toBe(false);
      expect(() => resolvePackageDir("/home/user/.arcturn/packages", name), name).toThrow(
        RegistryError,
      );
    }
    // The charset itself is unchanged: a dot inside a name is still ordinary.
    expect(isValidPackageName("my-pkg_1.0")).toBe(true);
  });

  it("rejects a traversal-attempting name when resolving a package directory", () => {
    expect(() => resolvePackageDir("/home/user/.arcturn/packages", "../../evil")).toThrow(
      RegistryError,
    );
  });

  it("resolves a safe name inside packagesRoot", () => {
    const dir = resolvePackageDir("/home/user/.arcturn/packages", "safe-name");
    expect(dir).toBe(resolve("/home/user/.arcturn/packages", "safe-name"));
  });
});

/* installPackage ----------------------------------------------------------------- */

describe("installPackage", () => {
  it("detects skills and extensions by convention and links them", async () => {
    const { url } = await makeGitRepo({
      "skills/greet.md": "---\ndescription: greets\n---\nHello $ARGUMENTS",
      "skills/deep/SKILL.md": "---\ndescription: deep\n---\nDeep skill body",
      "extensions/hello.js": "export default function () {}",
    });
    const paths = await makeRegistry();

    const result = await installPackage({
      source: url,
      paths,
      confirmExecutableCode: approve,
    });

    expect(result.installed).toBe(true);
    expect(result.declined).toBe(false);
    const record = result.record;
    expect(record).toBeDefined();
    expect(record?.provides.skills.sort()).toEqual(["deep", "greet.md"]);
    expect(record?.provides.extensions).toEqual(["hello.js"]);
    expect(record?.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(record?.pinned).toBe(false);

    expect(await exists(join(paths.skillsRoot, "greet.md"))).toBe(true);
    expect(await exists(join(paths.skillsRoot, "deep"))).toBe(true);
    expect(await exists(join(paths.extensionsRoot, "hello.js"))).toBe(true);
    expect(await isSymlink(join(paths.skillsRoot, "greet.md"))).toBe(true);

    // The clone's .git directory is stripped from the installed copy.
    expect(await exists(join(paths.packagesRoot, record?.name ?? "", ".git"))).toBe(false);
    expect(
      await exists(join(paths.packagesRoot, record?.name ?? "", ".arcturn-install.json")),
    ).toBe(true);
  });

  it("requires an explicit confirmation before linking extensions, and fails closed by default", async () => {
    const { url } = await makeGitRepo({
      "skills/greet.md": "hello",
      "extensions/hello.js": "export default function () {}",
    });
    const paths = await makeRegistry();

    const result = await installPackage({ source: url, paths });

    expect(result.installed).toBe(false);
    expect(result.declined).toBe(true);
    expect(await readdir(paths.packagesRoot).catch(() => [])).toEqual([]);
    expect(await exists(paths.skillsRoot)).toBe(false);
    expect(await exists(paths.extensionsRoot)).toBe(false);
  });

  it("declining the executable-code confirmation installs nothing, not even skills", async () => {
    const { url } = await makeGitRepo({
      "skills/greet.md": "hello",
      "extensions/hello.js": "export default function () {}",
    });
    const paths = await makeRegistry();

    const result = await installPackage({ source: url, paths, confirmExecutableCode: decline });

    expect(result.installed).toBe(false);
    expect(result.declined).toBe(true);
    expect(await readdir(paths.packagesRoot).catch(() => [])).toEqual([]);
    expect(await exists(paths.skillsRoot)).toBe(false);
  });

  it("--skills-only never prompts and never links extensions, but keeps them on disk inertly", async () => {
    const { url } = await makeGitRepo({
      "skills/greet.md": "hello",
      "extensions/hello.js": "export default function () {}",
    });
    const paths = await makeRegistry();

    let confirmCalls = 0;
    const result = await installPackage({
      source: url,
      paths,
      skillsOnly: true,
      confirmExecutableCode: () => {
        confirmCalls++;
        return true;
      },
    });

    expect(confirmCalls).toBe(0);
    expect(result.installed).toBe(true);
    expect(result.record?.skillsOnly).toBe(true);
    expect(result.record?.provides.extensions).toEqual([]);
    expect(await exists(join(paths.extensionsRoot, "hello.js"))).toBe(false);
    // Still present at rest, just never linked into the scanned extensions root.
    expect(
      await exists(join(paths.packagesRoot, result.record?.name ?? "", "extensions", "hello.js")),
    ).toBe(true);
  });

  it("supports a manifest with explicit provides paths", async () => {
    const { url } = await makeGitRepo({
      "arcturn.json": JSON.stringify({
        name: "custom-pack",
        description: "a manifest-driven pack",
        version: "1.0.0",
        provides: { skills: ["custom/one.md"] },
      }),
      "custom/one.md": "custom skill body",
    });
    const paths = await makeRegistry();

    const result = await installPackage({ source: url, paths });

    expect(result.installed).toBe(true);
    expect(result.record?.provides.skills).toEqual(["one.md"]);
    expect(result.record?.manifest).toEqual({
      name: "custom-pack",
      description: "a manifest-driven pack",
      version: "1.0.0",
    });
    expect(await exists(join(paths.skillsRoot, "one.md"))).toBe(true);
  });

  it("falls back to convention when the manifest is malformed", async () => {
    const { url } = await makeGitRepo({
      "arcturn.json": "{ not valid json",
      "skills/a.md": "a",
    });
    const paths = await makeRegistry();

    const result = await installPackage({ source: url, paths });

    expect(result.installed).toBe(true);
    expect(result.record?.provides.skills).toEqual(["a.md"]);
    expect(result.warnings.some((warning) => warning.includes("invalid JSON"))).toBe(true);
  });

  it("treats a manifest-free, skills/-free package as a flat folder of markdown skills", async () => {
    const { url } = await makeGitRepo({
      "greeting.md": "hello",
      "farewell.md": "bye",
      "README.md": "not a skill",
    });
    const paths = await makeRegistry();

    const result = await installPackage({ source: url, paths });

    expect(result.record?.provides.skills.sort()).toEqual(["farewell.md", "greeting.md"]);
    expect(await exists(join(paths.skillsRoot, "README.md"))).toBe(false);
  });

  it("merges a package's mcp.json into the shared mcp config, skipping name collisions", async () => {
    const first = await makeGitRepo({
      "mcp.json": JSON.stringify({ servers: { demo: { type: "stdio", command: "echo" } } }),
    });
    const second = await makeGitRepo({
      "mcp.json": JSON.stringify({ servers: { demo: { type: "stdio", command: "other" } } }),
    });
    const paths = await makeRegistry();

    const one = await installPackage({ source: first.url, name: "pkg-one", paths });
    expect(one.record?.provides.mcpServers).toEqual(["demo"]);

    const two = await installPackage({ source: second.url, name: "pkg-two", paths });
    expect(two.record?.provides.mcpServers).toEqual([]);
    expect(two.warnings.some((warning) => warning.includes("demo"))).toBe(true);

    const mcpConfig = JSON.parse(await readFile(paths.mcpConfigPath, "utf8"));
    expect(mcpConfig.servers.demo.command).toBe("echo"); // first package's entry wins
  });

  it("installs from a plain local directory (no git) and records no commit", async () => {
    const dir = await scratchDir("arcturn-registry-local-");
    await writeFiles(dir, { "skills/a.md": "a" });
    const paths = await makeRegistry();

    const result = await installPackage({ source: dir, paths });

    expect(result.installed).toBe(true);
    expect(result.record?.sourceKind).toBe("local-path");
    expect(result.record?.commit).toBeUndefined();
    expect(result.record?.provides.skills).toEqual(["a.md"]);
  });

  it("refuses to install over an already-installed package name", async () => {
    const { url } = await makeGitRepo({ "skills/a.md": "a" });
    const paths = await makeRegistry();
    await installPackage({ source: url, name: "dup", paths });

    await expect(installPackage({ source: url, name: "dup", paths })).rejects.toThrow(
      RegistryError,
    );
  });

  it("warns and skips a skill name collision between two different packages", async () => {
    const first = await makeGitRepo({ "skills/shared.md": "from first" });
    const second = await makeGitRepo({ "skills/shared.md": "from second" });
    const paths = await makeRegistry();

    const one = await installPackage({ source: first.url, name: "pkg-one", paths });
    const two = await installPackage({ source: second.url, name: "pkg-two", paths });

    expect(one.record?.provides.skills).toEqual(["shared.md"]);
    expect(two.record?.provides.skills).toEqual([]);
    expect(two.warnings.some((warning) => warning.includes("shared.md"))).toBe(true);
    expect(await readFile(join(paths.skillsRoot, "shared.md"), "utf8")).toBe("from first");
  });

  it("honours a pinned tag ref at install time", async () => {
    const { dir, url } = await makeGitRepo({ "skills/a.md": "v1 content" });
    await gitRun(["tag", "v1"], dir);
    await writeFiles(dir, { "skills/a.md": "v2 content" });
    await commitAll(dir, "v2");
    const paths = await makeRegistry();

    const result = await installPackage({ source: `${url}@v1`, paths });

    expect(result.record?.pinned).toBe(true);
    expect(result.record?.ref).toBe("v1");
    expect(await readFile(join(paths.skillsRoot, "a.md"), "utf8")).toBe("v1 content");
  });

  it("rejects an invalid --name override", async () => {
    const { url } = await makeGitRepo({ "skills/a.md": "a" });
    const paths = await makeRegistry();
    await expect(installPackage({ source: url, name: "../../evil", paths })).rejects.toThrow(
      RegistryError,
    );
  });
});

/* listPackages / removePackage --------------------------------------------------- */

describe("listPackages / removePackage", () => {
  it("round-trips install -> list -> remove", async () => {
    const { url } = await makeGitRepo({
      "skills/a.md": "a",
      "extensions/ext.js": "export default function () {}",
      "mcp.json": JSON.stringify({ servers: { srv: { type: "stdio", command: "echo" } } }),
    });
    const paths = await makeRegistry();

    const installed = await installPackage({
      source: url,
      name: "roundtrip",
      paths,
      confirmExecutableCode: approve,
    });
    expect(installed.installed).toBe(true);

    const listed = await listPackages(paths);
    expect(listed.map((record) => record.name)).toEqual(["roundtrip"]);
    expect(listed[0]?.provides.extensions).toEqual(["ext.js"]);

    const removed = await removePackage("roundtrip", paths);
    expect(removed.removedSkills).toEqual(["a.md"]);
    expect(removed.removedExtensions).toEqual(["ext.js"]);
    expect(removed.removedMcpServers).toEqual(["srv"]);

    expect(await exists(join(paths.skillsRoot, "a.md"))).toBe(false);
    expect(await exists(join(paths.extensionsRoot, "ext.js"))).toBe(false);
    expect(await exists(join(paths.packagesRoot, "roundtrip"))).toBe(false);
    const mcpConfig = JSON.parse(await readFile(paths.mcpConfigPath, "utf8"));
    expect(mcpConfig.servers.srv).toBeUndefined();

    expect(await listPackages(paths)).toEqual([]);
  });

  it("lists nothing for a fresh registry", async () => {
    const paths = await makeRegistry();
    expect(await listPackages(paths)).toEqual([]);
  });

  it("throws removing a package that isn't installed", async () => {
    const paths = await makeRegistry();
    await expect(removePackage("nope", paths)).rejects.toThrow(RegistryError);
  });

  it("rejects a traversal-attempting name on removal", async () => {
    const paths = await makeRegistry();
    await expect(removePackage("../../evil", paths)).rejects.toThrow(RegistryError);
  });
});

/* updatePackage / updateAllPackages ------------------------------------------------ */

describe("updatePackage", () => {
  it("never moves a pinned package", async () => {
    const { dir, url } = await makeGitRepo({ "skills/a.md": "v1" });
    await gitRun(["tag", "v1"], dir);
    await writeFiles(dir, { "skills/a.md": "v2" });
    const v2Commit = await commitAll(dir, "v2");
    const paths = await makeRegistry();

    const installed = await installPackage({ source: `${url}@v1`, name: "pinned-pkg", paths });
    const v1Commit = installed.record?.commit;

    const report = await updatePackage("pinned-pkg", { paths });

    expect(report.reason).toBe("pinned");
    expect(report.changed).toBe(false);
    expect(report.fromCommit).toBe(v1Commit);
    expect(report.fromCommit).not.toBe(v2Commit);
    expect(await readFile(join(paths.skillsRoot, "a.md"), "utf8")).toBe("v1");
  });

  it("reports up to date when nothing changed upstream", async () => {
    const { url } = await makeGitRepo({ "skills/a.md": "content" });
    const paths = await makeRegistry();
    const installed = await installPackage({ source: url, name: "steady", paths });

    const report = await updatePackage("steady", { paths });

    expect(report.reason).toBe("up-to-date");
    expect(report.changed).toBe(false);
    expect(report.fromCommit).toBe(installed.record?.commit);
  });

  it("re-fetches an unpinned package, relinking added/removed/modified files", async () => {
    const { dir, url } = await makeGitRepo({
      "skills/a.md": "old content",
      "extensions/ext.js": "export default function () {}",
    });
    const paths = await makeRegistry();
    await installPackage({ source: url, name: "moving", paths, confirmExecutableCode: approve });

    await writeFiles(dir, { "skills/a.md": "new content", "skills/b.md": "brand new" });
    await gitRun(["rm", "--quiet", "extensions/ext.js"], dir);
    const newCommit = await commitAll(dir, "update");

    const report = await updatePackage("moving", { paths, confirmExecutableCode: approve });

    expect(report.reason).toBe("updated");
    expect(report.changed).toBe(true);
    expect(report.toCommit).toBe(newCommit);
    expect(report.addedFiles).toContain("skills/b.md");
    expect(report.removedFiles).toContain("extensions/ext.js");
    expect(report.modifiedFiles).toContain("skills/a.md");

    expect(await readFile(join(paths.skillsRoot, "a.md"), "utf8")).toBe("new content");
    expect(await exists(join(paths.skillsRoot, "b.md"))).toBe(true);
    expect(await exists(join(paths.extensionsRoot, "ext.js"))).toBe(false);
  });

  it("re-gates newly introduced extensions behind the confirmation, and changes nothing on decline", async () => {
    const { dir, url } = await makeGitRepo({ "skills/a.md": "content" });
    const paths = await makeRegistry();
    const installed = await installPackage({ source: url, name: "grows-code", paths });

    await writeFiles(dir, { "extensions/new.js": "export default function () {}" });
    await commitAll(dir, "add extension");

    const declined = await updatePackage("grows-code", { paths, confirmExecutableCode: decline });
    expect(declined.reason).toBe("declined");
    expect(declined.changed).toBe(false);
    expect(await exists(join(paths.extensionsRoot, "new.js"))).toBe(false);
    // The package on disk is untouched: still at the pre-update commit.
    const stillOld = await readInstallRecordForTest(paths, "grows-code");
    expect(stillOld?.commit).toBe(installed.record?.commit);

    const approved = await updatePackage("grows-code", { paths, confirmExecutableCode: approve });
    expect(approved.reason).toBe("updated");
    expect(await exists(join(paths.extensionsRoot, "new.js"))).toBe(true);
  });

  it("reports not-a-package for an unknown name", async () => {
    const paths = await makeRegistry();
    const report = await updatePackage("nope", { paths });
    expect(report.reason).toBe("not-a-package");
  });

  it("updates every installed package via updateAllPackages", async () => {
    const steady = await makeGitRepo({ "skills/a.md": "steady" });
    const mover = await makeGitRepo({ "skills/a.md": "old" });
    const paths = await makeRegistry();
    await installPackage({ source: steady.url, name: "steady", paths });
    await installPackage({ source: mover.url, name: "mover", paths });

    await writeFiles(mover.dir, { "skills/a.md": "new" });
    await commitAll(mover.dir, "change");

    const reports = await updateAllPackages({ paths });
    const byName = new Map(reports.map((report) => [report.name, report]));
    expect(byName.get("steady")?.reason).toBe("up-to-date");
    expect(byName.get("mover")?.reason).toBe("updated");
  });
});

async function readInstallRecordForTest(paths: RegistryPaths, name: string) {
  const raw = await readFile(join(paths.packagesRoot, name, ".arcturn-install.json"), "utf8");
  return JSON.parse(raw) as { commit?: string };
}

/* Formatting -------------------------------------------------------------------- */

describe("formatting helpers", () => {
  it("formats an install summary", async () => {
    const { url } = await makeGitRepo({ "skills/a.md": "a" });
    const paths = await makeRegistry();
    const result = await installPackage({ source: url, name: "fmt-pkg", paths });
    const lines = formatInstallSummary(result);
    expect(lines[0]).toContain('Installed "fmt-pkg"');
    expect(lines.some((line) => line.includes("skills:"))).toBe(true);
  });

  it("formats a decline", () => {
    const declined: InstallResult = { installed: false, declined: true, name: "x", warnings: [] };
    expect(formatInstallSummary(declined)[0]).toContain("cancelled");
  });

  it("formats an empty package list", () => {
    expect(formatPackageList([])[0]).toContain("No packages installed");
  });

  it("formats a remove summary", () => {
    const lines = formatRemoveSummary({
      name: "x",
      removedSkills: ["a.md"],
      removedExtensions: [],
      removedThemes: [],
      removedMcpServers: [],
    });
    expect(lines[0]).toContain('Removed "x"');
    expect(lines.some((line) => line.includes("a.md"))).toBe(true);
  });

  it("formats every update reason", () => {
    expect(
      formatUpdateReport({
        name: "x",
        changed: false,
        reason: "not-a-package",
        addedFiles: [],
        removedFiles: [],
        modifiedFiles: [],
      }),
    ).toContain("not installed");
    expect(
      formatUpdateReport({
        name: "x",
        changed: false,
        reason: "pinned",
        addedFiles: [],
        removedFiles: [],
        modifiedFiles: [],
      }),
    ).toContain("pinned");
    expect(
      formatUpdateReport({
        name: "x",
        changed: false,
        reason: "up-to-date",
        addedFiles: [],
        removedFiles: [],
        modifiedFiles: [],
      }),
    ).toContain("up to date");
    expect(
      formatUpdateReport({
        name: "x",
        changed: false,
        reason: "declined",
        addedFiles: [],
        removedFiles: [],
        modifiedFiles: [],
      }),
    ).toContain("not approved");
    expect(
      formatUpdateReport({
        name: "x",
        changed: false,
        reason: "error",
        error: "boom",
        addedFiles: [],
        removedFiles: [],
        modifiedFiles: [],
      }),
    ).toContain("boom");
    expect(
      formatUpdateReport({
        name: "x",
        changed: true,
        reason: "updated",
        fromCommit: "aaaa",
        toCommit: "bbbb",
        addedFiles: ["a"],
        removedFiles: [],
        modifiedFiles: [],
      }),
    ).toContain("updated");
  });
});

/* createRegistryCommands ---------------------------------------------------------- */

interface FakeUi extends CommandUi {
  lines: string[];
  notices: { level: string; text: string }[];
}

function fakeUi(answers: readonly unknown[] = []): FakeUi {
  const queue = [...answers];
  const ui: FakeUi = {
    lines: [],
    notices: [],
    print(content) {
      ui.lines.push(...(typeof content === "string" ? content.split("\n") : content));
    },
    notice(level, text) {
      ui.notices.push({ level, text });
    },
    async select<T>(_title: string, _options: readonly SelectOption<T>[]) {
      return (queue.length > 0 ? queue.shift() : undefined) as T | undefined;
    },
    setInput() {},
    clear() {},
    exit() {},
  };
  return ui;
}

describe("createRegistryCommands", () => {
  it("wires /add, /packages, /remove and /update through the live CommandUi", async () => {
    const { url } = await makeGitRepo({
      "skills/greet.md": "hello",
      "extensions/ext.js": "export default function () {}",
    });
    const scratch = await makeScratch();
    cleanupDirs.push(scratch.root);
    const runtime = await buildTestRuntime(scratch);
    const commands = createRegistryCommands();
    const add = commands.find((command) => command.name === "add");
    const packagesCmd = commands.find((command) => command.name === "packages");
    const removeCmd = commands.find((command) => command.name === "remove");
    const updateCmd = commands.find((command) => command.name === "update");
    expect(add && packagesCmd && removeCmd && updateCmd).toBeTruthy();

    // Decline the executable-code prompt: nothing installed.
    const declineUi = fakeUi([false]);
    await add?.run({
      runtime,
      ui: declineUi,
      args: `${url} --name cmd-pkg`,
      commands: undefined as never,
    });
    expect(declineUi.lines.some((line) => line.includes("cancelled"))).toBe(true);

    // Approve it this time.
    const approveUi = fakeUi([true]);
    await add?.run({
      runtime,
      ui: approveUi,
      args: `${url} --name cmd-pkg`,
      commands: undefined as never,
    });
    expect(approveUi.lines.some((line) => line.includes('Installed "cmd-pkg"'))).toBe(true);

    const listUi = fakeUi();
    await packagesCmd?.run({ runtime, ui: listUi, args: "", commands: undefined as never });
    expect(listUi.lines.some((line) => line.includes("cmd-pkg"))).toBe(true);

    const updateUi = fakeUi();
    await updateCmd?.run({ runtime, ui: updateUi, args: "cmd-pkg", commands: undefined as never });
    expect(updateUi.lines.some((line) => line.includes("up to date"))).toBe(true);

    const removeConfirmUi = fakeUi([true]);
    await removeCmd?.run({
      runtime,
      ui: removeConfirmUi,
      args: "cmd-pkg",
      commands: undefined as never,
    });
    expect(removeConfirmUi.lines.some((line) => line.includes('Removed "cmd-pkg"'))).toBe(true);

    const removeAgainUi = fakeUi([true]);
    await removeCmd?.run({
      runtime,
      ui: removeAgainUi,
      args: "cmd-pkg",
      commands: undefined as never,
    });
    expect(removeAgainUi.notices.some((notice) => notice.level === "error")).toBe(true);
  });

  it("/add --skills-only never prompts", async () => {
    const { url } = await makeGitRepo({
      "skills/greet.md": "hello",
      "extensions/ext.js": "export default function () {}",
    });
    const scratch = await makeScratch();
    cleanupDirs.push(scratch.root);
    const runtime = await buildTestRuntime(scratch);
    const commands = createRegistryCommands();
    const add = commands.find((command) => command.name === "add");

    const ui = fakeUi(); // no queued answers; a select() call would return undefined and fail the install
    await add?.run({
      runtime,
      ui,
      args: `${url} --name skills-only-pkg --skills-only`,
      commands: undefined as never,
    });
    expect(ui.lines.some((line) => line.includes('Installed "skills-only-pkg"'))).toBe(true);
  });

  it("/add reports a usage error for missing arguments", async () => {
    const scratch = await makeScratch();
    cleanupDirs.push(scratch.root);
    const runtime = await buildTestRuntime(scratch);
    const commands = createRegistryCommands();
    const add = commands.find((command) => command.name === "add");
    const ui = fakeUi();
    await add?.run({ runtime, ui, args: "", commands: undefined as never });
    expect(
      ui.notices.some((notice) => notice.level === "error" && notice.text.includes("Usage")),
    ).toBe(true);
  });

  it("/packages reports an empty registry", async () => {
    const scratch = await makeScratch();
    cleanupDirs.push(scratch.root);
    const runtime = await buildTestRuntime(scratch);
    const commands = createRegistryCommands();
    const packagesCmd = commands.find((command) => command.name === "packages");
    const ui = fakeUi();
    await packagesCmd?.run({ runtime, ui, args: "", commands: undefined as never });
    expect(ui.lines.some((line) => line.includes("No packages installed"))).toBe(true);
  });
});
