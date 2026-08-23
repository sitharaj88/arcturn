/**
 * Task: add error handling.
 *
 * `loadConfig` crashes the process (uncaught `SyntaxError` or `ENOENT`)
 * instead of returning a result. The test suite expects a `{ ok, value }` /
 * `{ ok: false, error }` shape and never wants an uncaught throw.
 */

import type { EvalTask } from "../task.js";
import { commandSucceeds, fileContains } from "../task.js";
import { writeFixtureFiles } from "./fixture-utils.js";

const CONFIG_JS = `import { readFileSync } from "node:fs";

export function loadConfig(path) {
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw);
}
`;

const VALID_JSON = `{ "port": 8080 }\n`;
const INVALID_JSON = `{ "port": 8080,\n`;

const CONFIG_TEST_JS = `import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "./config.mjs";

test("returns an ok result for valid config", () => {
  const result = loadConfig(new URL("./fixtures/valid.json", import.meta.url));
  assert.deepEqual(result, { ok: true, value: { port: 8080 } });
});

test("returns an error result instead of throwing for invalid JSON", () => {
  const result = loadConfig(new URL("./fixtures/invalid.json", import.meta.url));
  assert.equal(result.ok, false);
  assert.equal(typeof result.error, "string");
});

test("returns an error result instead of throwing for a missing file", () => {
  const result = loadConfig(new URL("./fixtures/missing.json", import.meta.url));
  assert.equal(result.ok, false);
  assert.equal(typeof result.error, "string");
});
`;

const VERIFY_MJS = `import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.mjs";

const dir = mkdtempSync(join(tmpdir(), "verify-config-"));
try {
  const validPath = join(dir, "ok.json");
  writeFileSync(validPath, JSON.stringify({ host: "localhost" }));
  const ok = loadConfig(validPath);
  assert.equal(ok.ok, true, "valid file should report ok: true");
  assert.deepEqual(ok.value, { host: "localhost" });

  const brokenPath = join(dir, "broken.json");
  writeFileSync(brokenPath, "{ not json");
  const broken = loadConfig(brokenPath);
  assert.equal(broken.ok, false, "invalid JSON must not throw; it should report ok: false");

  const missing = loadConfig(join(dir, "does-not-exist.json"));
  assert.equal(missing.ok, false, "a missing file must not throw; it should report ok: false");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log("verify: ok");
`;

export const handleInvalidConfig: EvalTask = {
  id: "handle-invalid-config",
  description: "Replace uncaught exceptions with a { ok, value | error } result shape.",
  prompt:
    "loadConfig in config.mjs crashes the process on invalid JSON or a missing file instead of " +
    "returning a result. Update it (and only it) so it returns { ok: true, value } on success " +
    "and { ok: false, error } on failure, matching config.test.mjs, without ever throwing.",
  setup: (dir) =>
    writeFixtureFiles(dir, {
      "config.mjs": CONFIG_JS,
      "config.test.mjs": CONFIG_TEST_JS,
      "fixtures/valid.json": VALID_JSON,
      "fixtures/invalid.json": INVALID_JSON,
      ".eval/verify.mjs": VERIFY_MJS,
    }),
  assertions: [
    commandSucceeds("node --test"),
    commandSucceeds("node .eval/verify.mjs"),
    fileContains("config.mjs", /\bcatch\b/),
  ],
  timeoutMs: 3 * 60_000,
  tags: ["error-handling", "easy"],
};
