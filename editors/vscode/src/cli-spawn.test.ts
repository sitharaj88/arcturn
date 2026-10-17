import { describe, expect, it } from "vitest";
import { resolveCliSpawn } from "./cli-spawn.js";

const NPM_DIR = "C:\\Users\\me\\AppData\\Roaming\\npm";
const SHIM = `${NPM_DIR}\\arcturn.cmd`;
const MAIN = `${NPM_DIR}\\node_modules\\arcturn\\dist\\main.js`;

function probe(
  files: readonly string[],
  platform: NodeJS.Platform = "win32",
  env: Record<string, string | undefined> = {},
) {
  return { platform, env, isFile: (candidate: string) => files.includes(candidate) };
}

describe("resolveCliSpawn", () => {
  it("spawns a POSIX binary directly, with no shell in between", () => {
    expect(resolveCliSpawn("/usr/local/bin/arcturn", ["serve"], probe([], "linux"))).toEqual({
      executable: "/usr/local/bin/arcturn",
      args: ["serve"],
      spawnOptions: {},
    });
  });

  it("spawns a real Windows executable directly as well", () => {
    expect(resolveCliSpawn("C:\\bin\\arcturn.exe", ["serve"], probe([]))).toEqual({
      executable: "C:\\bin\\arcturn.exe",
      args: ["serve"],
      spawnOptions: {},
    });
  });

  // `npm install -g arcturn` on Windows writes `arcturn.cmd`, and Node refuses
  // to spawn a `.cmd` without a shell (EINVAL, the CVE-2024-27980 fix). The
  // shim itself only ever runs `node "<dir>\node_modules\arcturn\dist\main.js"`,
  // so when that layout is beside the shim the extension runs the same thing
  // — and the child it holds IS the server, not a cmd.exe in front of it.
  it("runs the npm shim's own entry point under node instead of the .cmd", () => {
    const plan = resolveCliSpawn(SHIM, ["serve", "--token", "t"], probe([MAIN]));
    expect(plan).toEqual({
      executable: "node",
      args: [MAIN, "serve", "--token", "t"],
      spawnOptions: {},
    });
  });

  it("prefers the node.exe npm installed beside the shim, as the shim does", () => {
    const node = `${NPM_DIR}\\node.exe`;
    const plan = resolveCliSpawn(SHIM, ["--version"], probe([MAIN, node]));
    expect(plan.executable).toBe(node);
    expect(plan.args).toEqual([MAIN, "--version"]);
  });

  it("reads the extension case-insensitively", () => {
    const plan = resolveCliSpawn(`${NPM_DIR}\\arcturn.CMD`, [], probe([MAIN]));
    expect(plan.executable).toBe("node");
  });

  it("falls back to %ComSpec% for a .cmd outside the npm layout, quoted so a spaced path survives", () => {
    const wrapper = "C:\\Program Files\\arcturn\\arcturn.cmd";
    const plan = resolveCliSpawn(
      wrapper,
      ["serve", "--cwd", "D:\\my repo"],
      probe([], "win32", { ComSpec: "C:\\Windows\\System32\\cmd.exe" }),
    );
    expect(plan.executable).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(plan.args).toEqual([
      "/d",
      "/s",
      "/c",
      '""C:\\Program Files\\arcturn\\arcturn.cmd" serve --cwd "D:\\my repo""',
    ]);
    // Without this, libuv re-escapes the line and cmd.exe sees something else.
    expect(plan.spawnOptions).toEqual({ windowsVerbatimArguments: true });
  });

  it("defaults the shell to cmd.exe when ComSpec is unset, whatever its case", () => {
    expect(resolveCliSpawn("C:\\x\\a.bat", [], probe([])).executable).toBe("cmd.exe");
    expect(
      resolveCliSpawn("C:\\x\\a.bat", [], probe([], "win32", { comspec: "C:\\w\\cmd.exe" }))
        .executable,
    ).toBe("C:\\w\\cmd.exe");
  });

  it("refuses to build a cmd.exe line from an argument that could end its own quotes or expand", () => {
    const wrapper = "C:\\tools\\arcturn.cmd";
    const p = probe([], "win32", {});
    // `--model 'x"&calc&"'` from a workspace setting would run calc.
    expect(() => resolveCliSpawn(wrapper, ["serve", "--model", 'x"&calc&"'], p)).toThrow(
      /cmd\.exe/,
    );
    expect(() => resolveCliSpawn(wrapper, ["serve", "--cwd", "D:\\%TEMP%\\w"], p)).toThrow(
      /cmd\.exe/,
    );
    // The npm layout never reaches a shell, so any argument is fine there.
    const direct = resolveCliSpawn(SHIM, ["--model", 'x"&calc&"'], probe([MAIN]));
    expect(direct.args).toEqual([MAIN, "--model", 'x"&calc&"']);
  });
});
