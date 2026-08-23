/** The starter suite: the built-in eval tasks Arcturn ships with. */

import type { EvalTask } from "../task.js";
import { asyncConcurrentTaskPool } from "./async-concurrent-task-pool.js";
import { asyncSingleFlightMemoize } from "./async-single-flight-memoize.js";
import { catchDiscountBug } from "./catch-discount-bug.js";
import { clampEdgeCases } from "./clamp-edge-cases.js";
import { compatDurationFormat } from "./compat-duration-format.js";
import { debugSharedRangeHelper } from "./debug-shared-range-helper.js";
import { debugStalePriceCache } from "./debug-stale-price-cache.js";
import { edgeCsvRowParser } from "./edge-csv-row-parser.js";
import { edgeSumDollarsPrecision } from "./edge-sum-dollars-precision.js";
import { edgeTruncateUnicode } from "./edge-truncate-unicode.js";
import { edgeWordFrequencyUnicode } from "./edge-word-frequency-unicode.js";
import { fixBinarySearchBug } from "./fix-binary-search-bug.js";
import { fixFailingSumTest } from "./fix-failing-sum-test.js";
import { handleInvalidConfig } from "./handle-invalid-config.js";
import { multifileLibraryLoanReturn } from "./multifile-library-loan-return.js";
import { perfQuadraticDuplicates } from "./perf-quadratic-duplicates.js";
import { renameComputeTotal } from "./rename-compute-total.js";
import { trapDedupeKeepFirst } from "./trap-dedupe-keep-first.js";

export { asyncConcurrentTaskPool } from "./async-concurrent-task-pool.js";
export { asyncSingleFlightMemoize } from "./async-single-flight-memoize.js";
export { catchDiscountBug } from "./catch-discount-bug.js";
export { clampEdgeCases } from "./clamp-edge-cases.js";
export { compatDurationFormat } from "./compat-duration-format.js";
export { debugSharedRangeHelper } from "./debug-shared-range-helper.js";
export { debugStalePriceCache } from "./debug-stale-price-cache.js";
export { edgeCsvRowParser } from "./edge-csv-row-parser.js";
export { edgeSumDollarsPrecision } from "./edge-sum-dollars-precision.js";
export { edgeTruncateUnicode } from "./edge-truncate-unicode.js";
export { edgeWordFrequencyUnicode } from "./edge-word-frequency-unicode.js";
export { fixBinarySearchBug } from "./fix-binary-search-bug.js";
export { fixFailingSumTest } from "./fix-failing-sum-test.js";
export { handleInvalidConfig } from "./handle-invalid-config.js";
export { multifileLibraryLoanReturn } from "./multifile-library-loan-return.js";
export { perfQuadraticDuplicates } from "./perf-quadratic-duplicates.js";
export { renameComputeTotal } from "./rename-compute-total.js";
export { trapDedupeKeepFirst } from "./trap-dedupe-keep-first.js";

/**
 * Every built-in task, in a stable order: the original six small warm-up
 * tasks first, then the harder expansion set. Task ids are prefixed by kind
 * (`multifile-`, `debug-`, `async-`, `compat-`, `perf-`, `edge-`, `trap-`)
 * so `--tasks "debug-*"` (etc.) selects by kind even though the CLI globs
 * task ids, not tags; the `tags` field on each task is the canonical,
 * richer way to select by kind and difficulty for any tool that reads
 * `EvalTask.tags` directly.
 */
export const ALL_TASKS: EvalTask[] = [
  // Original starter suite (small, mostly single-file).
  fixFailingSumTest,
  clampEdgeCases,
  renameComputeTotal,
  fixBinarySearchBug,
  handleInvalidConfig,
  catchDiscountBug,
  // Expansion suite (meaningfully harder; several are expected fails).
  multifileLibraryLoanReturn,
  debugStalePriceCache,
  trapDedupeKeepFirst,
  asyncConcurrentTaskPool,
  compatDurationFormat,
  perfQuadraticDuplicates,
  edgeTruncateUnicode,
  asyncSingleFlightMemoize,
  debugSharedRangeHelper,
  edgeSumDollarsPrecision,
  edgeCsvRowParser,
  edgeWordFrequencyUnicode,
];
