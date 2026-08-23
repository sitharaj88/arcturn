/** Package identity, read from `package.json` at runtime. */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Human-facing product name. */
export const PRODUCT_NAME = "arcturn";

let cached: { name: string; version: string } | undefined;

/**
 * Read `name` and `version` out of the package manifest.
 *
 * Both `src/` and `dist/` sit one level below the package root, so the same
 * relative lookup works when running from source and from the build output.
 */
export function packageInfo(): { name: string; version: string } {
  if (cached) return cached;
  try {
    const path = fileURLToPath(new URL("../package.json", import.meta.url));
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    const record = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
    cached = {
      name: typeof record.name === "string" ? record.name : "arcturn",
      version: typeof record.version === "string" ? record.version : "0.0.0",
    };
  } catch {
    cached = { name: "arcturn", version: "0.0.0" };
  }
  return cached;
}

/** The CLI version string. */
export function version(): string {
  return packageInfo().version;
}
