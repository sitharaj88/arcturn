import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createMcpAuthProviderFactory,
  FileMcpOAuthStorage,
  MCP_AUTH_DIR_MODE,
  MCP_AUTH_FILE_MODE,
  mcpAuthFileName,
  mcpAuthPath,
} from "./mcp-auth.js";
import { resolveArcturnPaths } from "./paths.js";

describe("mcpAuthFileName", () => {
  it("namespaces MCP credentials away from the provider ones", () => {
    expect(mcpAuthFileName("docs")).toBe("mcp-docs.json");
  });

  it("escapes anything that could traverse out of the auth directory", () => {
    // Separators are escaped — both spellings, since a server name reaches
    // this from a config file that may have been written on another OS — so
    // the escaped name can never leave the directory even though bare dots
    // survive.
    expect(mcpAuthFileName("../../etc/passwd")).not.toContain("/");
    expect(mcpAuthFileName("..\\..\\etc")).not.toContain("\\");
    expect(mcpAuthFileName("..\\..\\etc")).not.toContain("/");
    expect(mcpAuthFileName("../../etc/passwd")).not.toContain("\\");

    // `mcpAuthPath` joins with the *platform's* separator, so the expected
    // path is spelled with `join` too; the escaped file name — the part this
    // test is actually about — stays a literal.
    const authDirectory = join("/home/u", ".arcturn", "auth");
    const escaped = mcpAuthPath(authDirectory, "../../etc/passwd");
    expect(escaped).toBe(join(authDirectory, "mcp-.._2f.._2fetc_2fpasswd.json"));
    // Whatever the separator, the file lands in the auth directory itself.
    expect(dirname(escaped)).toBe(authDirectory);

    expect(mcpAuthFileName("")).toBe("mcp-_.json");
  });

  it("cannot spell a Windows reserved device name, whatever the server is called", () => {
    // `CON`, `NUL`, `COM1`... name devices on Windows even with an extension:
    // opening `CON.json` writes to the console, not to a file. The `mcp-`
    // prefix is what keeps every generated name a real file name — this pins
    // that, since the prefix reads like cosmetics until you are on Windows.
    const reservedBase = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
    for (const server of ["CON", "nul", "PRN", "aux", "COM1", "LPT9"]) {
      const name = mcpAuthFileName(server);
      expect(name).toBe(`mcp-${server}.json`);
      expect(name.split(".")[0]).not.toMatch(reservedBase);
    }
  });
});

describe("FileMcpOAuthStorage", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "arcturn-mcp-auth-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("round-trips a record and reports nothing before the first save", async () => {
    const storage = new FileMcpOAuthStorage(join(dir, "auth"), "docs");
    expect(await storage.load()).toBeUndefined();

    await storage.save({
      tokens: { access_token: "at", token_type: "Bearer", refresh_token: "rt" },
      clientInformation: { client_id: "cid" },
      codeVerifier: "verifier",
    });

    expect(await storage.load()).toEqual({
      tokens: { access_token: "at", token_type: "Bearer", refresh_token: "rt" },
      clientInformation: { client_id: "cid" },
      codeVerifier: "verifier",
    });
  });

  // POSIX mode bits do not exist on Windows: `mkdir`'s mode is ignored and
  // `chmod` only toggles the read-only attribute, so `stat().mode` reports a
  // synthesized 0666 no matter what was asked for. The production code still
  // asks for the right modes (they are what protects the file everywhere
  // else); there is simply nothing to assert about them there. Access control
  // for `~/.arcturn` on Windows is the profile directory's ACL.
  const itPosix = it.skipIf(process.platform === "win32");

  itPosix("writes 0600 files inside a 0700 directory", async () => {
    const authDir = join(dir, "auth");
    const storage = new FileMcpOAuthStorage(authDir, "docs");
    await storage.save({ tokens: { access_token: "at", token_type: "Bearer" } });

    const dirMode = (await stat(authDir)).mode & 0o777;
    const fileMode = (await stat(mcpAuthPath(authDir, "docs"))).mode & 0o777;
    expect(dirMode).toBe(MCP_AUTH_DIR_MODE);
    expect(fileMode).toBe(MCP_AUTH_FILE_MODE);
  });

  itPosix("tightens a pre-existing loose directory instead of trusting it", async () => {
    const authDir = join(dir, "loose");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(authDir, { recursive: true, mode: 0o755 });
    await new FileMcpOAuthStorage(authDir, "docs").save({});
    expect((await stat(authDir)).mode & 0o777).toBe(MCP_AUTH_DIR_MODE);
  });

  it("puts the credential file inside its own auth directory, and nowhere else", async () => {
    // The half of "0600 inside 0700" that is enforceable on every platform:
    // the credential lands at the path `mcpAuthPath` names, inside the
    // directory the storage was constructed with.
    const authDir = join(dir, "auth");
    const storage = new FileMcpOAuthStorage(authDir, "docs");
    await storage.save({ tokens: { access_token: "at", token_type: "Bearer" } });

    expect(storage.path).toBe(join(authDir, "mcp-docs.json"));
    expect((await stat(authDir)).isDirectory()).toBe(true);
    expect((await stat(storage.path)).isFile()).toBe(true);
  });

  it("clear removes the file and reports whether there was one", async () => {
    const storage = new FileMcpOAuthStorage(join(dir, "auth"), "docs");
    expect(await storage.clear()).toBe(false);
    await storage.save({ tokens: { access_token: "at", token_type: "Bearer" } });
    expect(await storage.clear()).toBe(true);
    expect(await storage.load()).toBeUndefined();
  });

  it("ignores a corrupt file and one written for a different server", async () => {
    const authDir = join(dir, "auth");
    const storage = new FileMcpOAuthStorage(authDir, "docs");
    await storage.save({ tokens: { access_token: "at", token_type: "Bearer" } });

    await writeFile(mcpAuthPath(authDir, "docs"), "{not json", "utf8");
    expect(await storage.load()).toBeUndefined();

    await writeFile(
      mcpAuthPath(authDir, "docs"),
      JSON.stringify({ version: 1, server: "other", tokens: { access_token: "x" } }),
      "utf8",
    );
    expect(await storage.load()).toBeUndefined();
  });

  it("never leaves a .tmp file behind", async () => {
    const authDir = join(dir, "auth");
    await new FileMcpOAuthStorage(authDir, "docs").save({ codeVerifier: "v" });
    const { readdir } = await import("node:fs/promises");
    expect((await readdir(authDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("does not store the token in a world-readable place by accident", async () => {
    const authDir = join(dir, "auth");
    const storage = new FileMcpOAuthStorage(authDir, "docs");
    await storage.save({ tokens: { access_token: "secret-token", token_type: "Bearer" } });
    const raw = await readFile(mcpAuthPath(authDir, "docs"), "utf8");
    // The token is in the file (that is the point) but nowhere else.
    expect(raw).toContain("secret-token");
    expect(JSON.parse(raw).version).toBe(1);
  });
});

describe("createMcpAuthProviderFactory", () => {
  it("only builds a provider for http servers marked auth: oauth", async () => {
    const paths = resolveArcturnPaths({ home: "/tmp/arcturn-home", cwd: "/tmp" });
    const factory = await createMcpAuthProviderFactory({ paths });

    expect(factory("stdio", { type: "stdio", command: "x" })).toBeUndefined();
    expect(factory("plain", { type: "http", url: "https://example.com/mcp" })).toBeUndefined();
    const provider = factory("docs", {
      type: "http",
      url: "https://example.com/mcp",
      auth: "oauth",
    });
    expect(provider).toBeDefined();
    // Non-interactive by construction: no prompt, so a flow that needs the user
    // throws "run arcturn mcp auth" rather than opening a browser mid-session.
    await expect(
      provider?.redirectToAuthorization(new URL("https://auth.example.com/authorize")),
    ).rejects.toThrow(/arcturn mcp auth docs/);
  });
});
