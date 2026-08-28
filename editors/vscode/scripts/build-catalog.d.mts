/**
 * Types for the catalog generator, which is plain `.mjs` so it can run under
 * `node` with no build step. The test imports it to regenerate and compare.
 */
import type { Catalog } from "../src/hub/tree.js";

export function buildCatalog(dir?: string): Catalog;
