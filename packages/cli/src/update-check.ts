/**
 * The daily "is there a newer arcturn?" question, answered quietly.
 *
 * A notice, never an install: replacing a binary out from under its own
 * running process is not this tool's call, so the strongest thing this
 * module ever does is return a version string for the host to mention once.
 * Throttled through a state file so a new window is not a registry hit, and
 * every failure is silence — an engine that cannot check is merely
 * current-until-tomorrow.
 *
 * @packageDocumentation
 */

import { readFile, writeFile } from "node:fs/promises";

/** One check per day, measured from the last attempt (not the last success). */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** What {@link checkForUpdate} needs from the outside world, injectable for tests. */
export interface UpdateCheckOptions {
  /** The running version, from the package manifest. */
  readonly currentVersion: string;
  /** Absolute path of the throttle file, e.g. `~/.arcturn/update-check.json`. */
  readonly stateFile: string;
  /** Clock override (tests). */
  readonly now?: () => number;
  /** Registry probe override (tests). Resolves the latest published version. */
  readonly fetchLatestVersion?: () => Promise<string | undefined>;
}

/**
 * Returns the newer published version when there is one, `undefined` in
 * every other circumstance: already current, checked within the last day,
 * registry unreachable, unparsable versions. The throttle stamp is written
 * before the network is touched, so a hung registry cannot turn into a
 * probe per window.
 */
export async function checkForUpdate(options: UpdateCheckOptions): Promise<string | undefined> {
  const now = options.now?.() ?? Date.now();
  const last = await readLastChecked(options.stateFile);
  if (now - last < CHECK_INTERVAL_MS) return undefined;
  await writeLastChecked(options.stateFile, now);
  let latest: string | undefined;
  try {
    latest = await (options.fetchLatestVersion ?? fetchLatestVersion)();
  } catch {
    return undefined;
  }
  if (latest === undefined) return undefined;
  return isNewer(latest, options.currentVersion) ? latest : undefined;
}

/** Strictly newer, by numeric dotted comparison; unparsable answers `false`. */
export function isNewer(candidate: string, current: string): boolean {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (a === undefined || b === undefined) return false;
  for (let i = 0; i < 3; i++) {
    const delta = (a[i] ?? 0) - (b[i] ?? 0);
    if (delta !== 0) return delta > 0;
  }
  return false;
}

/** `"1.2.3"` → `[1, 2, 3]`; anything else (tags, ranges, nightlies) → `undefined`. */
function parseVersion(version: string): number[] | undefined {
  const parts = version.trim().split(".");
  if (parts.length < 2 || parts.length > 3) return undefined;
  const numbers = parts.map((part) => (/^\d+$/.test(part) ? Number(part) : Number.NaN));
  return numbers.some(Number.isNaN) ? undefined : numbers;
}

async function readLastChecked(stateFile: string): Promise<number> {
  try {
    const raw = JSON.parse(await readFile(stateFile, "utf8")) as { lastCheckedAt?: unknown };
    return typeof raw.lastCheckedAt === "number" ? raw.lastCheckedAt : 0;
  } catch {
    // Missing or malformed: never checked.
    return 0;
  }
}

async function writeLastChecked(stateFile: string, at: number): Promise<void> {
  try {
    await writeFile(stateFile, `${JSON.stringify({ lastCheckedAt: at })}\n`, "utf8");
  } catch {
    // A read-only home means a check per window instead of per day; harmless.
  }
}

/** Asks the npm registry for the latest published `arcturn`, capped at 5s. */
async function fetchLatestVersion(): Promise<string | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch("https://registry.npmjs.org/arcturn/latest", {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { version?: unknown };
    return typeof body.version === "string" ? body.version : undefined;
  } finally {
    clearTimeout(timer);
  }
}
