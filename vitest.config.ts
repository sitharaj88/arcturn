import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: [
      "packages/*/src/**/*.test.ts",
      "packages/*/test/**/*.test.ts",
      // The site's design-system checks (contrast, theme-block drift) run with
      // the monorepo suite so a token edit cannot ship without them. Both
      // spellings are needed: vitest finds this config by walking up, but roots
      // itself at the cwd, so the same files are `web/scripts/…` from here and
      // `scripts/…` when a web agent runs the suite from `web/`.
      "web/scripts/**/*.test.ts",
      "scripts/**/*.test.ts",
    ],
    environment: "node",
    testTimeout: 20_000,
    pool: "threads",
  },
});
