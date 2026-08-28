/**
 * Freeze `registry/*.json` into a snapshot the extension can ship.
 *
 * The hub is a directory of kits, and the panel should be able to show it
 * without asking the network for permission to exist. So the catalog is
 * bundled: no fetch, no host to reach, nothing that could be read as the
 * extension phoning home. The cost is that it is only as fresh as the last
 * release, which `catalog.test.ts` keeps honest by regenerating and comparing.
 *
 * Only the fields the tree renders are copied, by name. A field the registry
 * grows tomorrow is absent here until somebody decides it belongs in an
 * editor — the same rule `serve-mcp.ts` follows for a different reason.
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const registryDir = join(here, "..", "..", "..", "registry");
const out = join(here, "..", "src", "hub", "catalog.json");

/** Build the snapshot from a registry directory. Exported so a test can re-run it. */
export function buildCatalog(dir = registryDir) {
  const kits = readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => JSON.parse(readFileSync(join(dir, file), "utf8")))
    .map((entry) => ({
      name: entry.name,
      source: entry.source,
      description: entry.description,
      kinds: entry.kinds ?? [],
      agents: (entry.disclosure?.agents ?? []).map((agent) => ({
        name: agent.name,
        lane: agent.lane,
        tools: agent.tools ?? [],
      })),
      workflows: (entry.disclosure?.workflows ?? []).map((workflow) => ({
        name: workflow.name,
        stages: workflow.stages,
        ...(workflow.budgetUsd === undefined ? {} : { budgetUsd: workflow.budgetUsd }),
      })),
      skills: (entry.disclosure?.skills ?? []).map((skill) => ({
        name: skill.name,
        line: skill.line,
      })),
    }));
  return { kits };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const catalog = buildCatalog();
  writeFileSync(out, `${JSON.stringify(catalog, null, 2)}\n`);
  console.log(`catalog: ${catalog.kits.length} kits → ${out}`);
}
