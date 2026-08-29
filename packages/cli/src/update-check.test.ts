import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkForUpdate, isNewer } from "./update-check.js";

async function scratchStateFile(): Promise<string> {
  return join(await mkdtemp(join(tmpdir(), "arcturn-update-")), "update-check.json");
}

describe("isNewer", () => {
  it("compares dotted numerics field by field, not lexically", () => {
    expect(isNewer("0.5.10", "0.5.2")).toBe(true);
    expect(isNewer("0.5.2", "0.5.10")).toBe(false);
    expect(isNewer("1.0.0", "0.9.9")).toBe(true);
    expect(isNewer("0.5.2", "0.5.2")).toBe(false);
  });

  it("never nags over a version it cannot parse", () => {
    expect(isNewer("0.6.0-beta.1", "0.5.2")).toBe(false);
    expect(isNewer("latest", "0.5.2")).toBe(false);
    expect(isNewer("0.6.0", "nightly")).toBe(false);
  });
});

describe("checkForUpdate", () => {
  it("reports a newer version once a day, and not on every window", async () => {
    const stateFile = await scratchStateFile();
    let asked = 0;
    let clock = 200_000_000;
    const check = () =>
      checkForUpdate({
        currentVersion: "0.5.2",
        stateFile,
        now: () => clock,
        fetchLatestVersion: async () => {
          asked += 1;
          return "0.6.0";
        },
      });

    expect(await check()).toBe("0.6.0");
    expect(asked).toBe(1);

    // An hour later, same day: throttled, no registry hit.
    clock += 60 * 60 * 1000;
    expect(await check()).toBeUndefined();
    expect(asked).toBe(1);

    // A day later: checked again.
    clock += 25 * 60 * 60 * 1000;
    expect(await check()).toBe("0.6.0");
    expect(asked).toBe(2);
  });

  it("stays silent when current, when the registry fails, and on a bad state file", async () => {
    const stateFile = await scratchStateFile();
    expect(
      await checkForUpdate({
        currentVersion: "0.6.0",
        stateFile,
        now: () => 200_000_000,
        fetchLatestVersion: async () => "0.6.0",
      }),
    ).toBeUndefined();

    const failing = await scratchStateFile();
    expect(
      await checkForUpdate({
        currentVersion: "0.5.2",
        stateFile: failing,
        now: () => 200_000_000,
        fetchLatestVersion: async () => {
          throw new Error("offline");
        },
      }),
    ).toBeUndefined();

    const malformed = await scratchStateFile();
    await writeFile(malformed, "{not json", "utf8");
    expect(
      await checkForUpdate({
        currentVersion: "0.5.2",
        stateFile: malformed,
        now: () => 200_000_000,
        fetchLatestVersion: async () => "0.6.0",
      }),
    ).toBe("0.6.0");
  });

  it("stamps the throttle before touching the network, so a hang cannot re-probe", async () => {
    const stateFile = await scratchStateFile();
    await checkForUpdate({
      currentVersion: "0.5.2",
      stateFile,
      now: () => 300_000_000,
      fetchLatestVersion: async () => {
        // The stamp must already be on disk while the "network" runs.
        const raw = JSON.parse(await readFile(stateFile, "utf8")) as { lastCheckedAt?: number };
        expect(raw.lastCheckedAt).toBe(300_000_000);
        return undefined;
      },
    });
  });
});
