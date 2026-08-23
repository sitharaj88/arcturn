/**
 * Speculative approval — branch prediction for agents.
 *
 * While a permission prompt sits in front of a human, the agent does not have
 * to sit still. It keeps working *speculatively*: every file mutation it makes
 * in the meantime lands in a shadow overlay keyed by the pending request id,
 * never in the real workspace. When the human answers:
 *
 * - **approve** → {@link SpeculationController.settle}`(id, true)` applies the
 *   shadow over the workspace, so the work the agent did while waiting lands
 *   instantly;
 * - **deny** → `settle(id, false)` throws the shadow away and the workspace is
 *   bit-for-bit what it was before the agent guessed.
 *
 * A speculation is *exactly* an {@link Overlay} whose fate is decided by a
 * permission answer, so it inherits the overlay's symlink confinement, atomic
 * writes and honest `{applied, errors}` reporting rather than re-implementing
 * any of it.
 *
 * ## Hard safety rules
 *
 * These four rules are the feature. Everything else is plumbing.
 *
 * 1. **Never apply implicitly (fail closed).** Only an explicit
 *    `settle(id, true)` writes anything to disk. A timeout, an abandoned
 *    request, a dropped connection, {@link SpeculationController.abandonAll} or
 *    process exit all discard. There is no code path from "nobody answered" to
 *    "the workspace changed". A shadow tree left on disk by a crash is inert:
 *    nothing in this module ever scans for or resumes an orphaned speculation.
 * 2. **Never speculate an irreversible side effect.** Only file mutations can
 *    be un-done by throwing a directory away, so only file mutations may be
 *    speculated. {@link isSpeculatable} is a conservative allowlist (`write`,
 *    `edit`) and {@link wrapToolsWithSpeculation} **blocks** everything else
 *    (`bash`, `fetch`, `websearch`, `mcp__*`, sub-agents, …) for as long as a
 *    speculation is open, returning an `isError` result that tells the model to
 *    wait for the approval. Speculatively running a shell command or POSTing to
 *    an API is precisely the thing that must never happen: no `discard()` can
 *    take those back.
 * 3. **Speculations are isolated from each other.** Each pending request gets
 *    its own overlay keyed by request id, so concurrent or nested speculations
 *    never see one another's writes, and settling one cannot drag another's
 *    half-finished guess onto disk. A nested speculation materialises from the
 *    **real** workspace, not from the outer speculation's shadow — a guess is
 *    never built on top of another unapproved guess.
 * 4. **Apply failures are surfaced, never swallowed.** `settle` reuses the
 *    overlay's `{applied, errors}` shape verbatim, reports a partial apply as
 *    `"partial"`, and resolves (never rejects) so a failed write cannot take
 *    the session down or be mistaken for a clean landing.
 *
 * See `INTEGRATION-speculation.md` at the repo root for how `runtime.ts`'s
 * `#ask` funnel wraps the requester, the `speculation` config key (default
 * **off** — this is opt-in), the wrap order relative to overlay/hooks/
 * checkpoints, and the honest list of what cannot be speculated.
 */

import { relative } from "node:path";
import type { Tool, ToolExecutionContext, ToolResult } from "@arcturn/types";
import type { Overlay, OverlayApplyError } from "./overlay.js";
import { wrapToolsWithOverlay } from "./overlay.js";

/** One open speculation: a shadow overlay tied to a pending permission request. */
export interface Speculation {
  /** The {@link PermissionRequest} id whose answer decides this shadow's fate. */
  readonly requestId: string;
  /**
   * The shadow this speculation's writes land in.
   *
   * Exposed so a host can inspect what is pending before settling — e.g.
   * snapshotting `(await overlay.changes()).map(c => c.path)` into the
   * checkpoint store so an approved apply stays undoable.
   */
  readonly overlay: Overlay;
}

/** How a speculation ended. */
export type SpeculationStatus =
  /** Approved, and every pending change was written to the workspace. */
  | "applied"
  /** Approved, but at least one path failed; see `errors` and `applied`. */
  | "partial"
  /** Denied or abandoned: the shadow was thrown away and nothing was written. */
  | "discarded"
  /** No speculation was open for that request id (already settled, or never begun). */
  | "unknown";

/** Result of {@link SpeculationController.settle}. */
export interface SpeculationOutcome {
  /** The permission request this speculation was betting on. */
  requestId: string;
  /** Whether the human approved. `false` for a denial and for `abandonAll`. */
  approved: boolean;
  /** How it ended; see {@link SpeculationStatus}. */
  status: SpeculationStatus;
  /** Real workspace paths successfully written back. Always empty when denied. */
  applied: readonly string[];
  /**
   * Real workspace paths whose speculative content was thrown away — every
   * pending change on a denial, and the paths that failed to apply on an
   * approval (their shadow is gone with the rest of the tree).
   */
  discarded: readonly string[];
  /** Per-path failures, in the overlay's shape. Empty on a clean run. */
  errors: readonly OverlayApplyError[];
}

/** Options for {@link createSpeculation}. */
export interface CreateSpeculationOptions {
  /**
   * Build the shadow overlay for one pending request. Called once per
   * {@link SpeculationController.begin} of a not-yet-open id.
   *
   * The integration is expected to return
   * `createOverlay({ cwd, dir: join(home, "speculations", sessionId, id) })`,
   * i.e. a **per-request** directory. Handing back one shared overlay for every
   * id would break safety rule 3 (isolation) and let a denial delete another
   * request's pending work.
   */
  overlayFor: (requestId: string) => Overlay;
}

/** Opens, settles and abandons speculations. See the module TSDoc for the rules. */
export interface SpeculationController {
  /**
   * Open a speculation for `requestId` — call this immediately *before* asking
   * the human, so every tool call made while the prompt is up is sheltered.
   *
   * Idempotent: beginning an already-open id returns the same
   * {@link Speculation} rather than replacing (and orphaning) its shadow.
   *
   * @param requestId - Id of the permission request being asked.
   * @returns The open speculation, whose overlay tools should write into.
   */
  begin(requestId: string): Speculation;

  /**
   * Resolve a speculation with the human's answer.
   *
   * `approved === true` applies the shadow over the real workspace through
   * {@link Overlay.apply} (symlink confinement, atomic writes and per-path
   * errors all intact) and then drops the shadow tree. `approved === false`
   * only discards. **This is the only code path in the module that writes to
   * the workspace** (safety rule 1).
   *
   * The speculation is closed *synchronously* on entry, before any I/O: a tool
   * call racing with the answer can no longer route writes into a shadow that
   * is already being applied, and a second `settle` of the same id returns
   * `"unknown"` instead of applying twice.
   *
   * Resolves rather than rejects on failure (safety rule 4): apply problems
   * come back in `errors` with status `"partial"`.
   *
   * @param requestId - Id passed to {@link SpeculationController.begin}.
   * @param approved - The human's decision (`decision.behavior === "allow"`).
   * @returns What landed and what was thrown away.
   */
  settle(requestId: string, approved: boolean): Promise<SpeculationOutcome>;

  /**
   * Discard **every** open speculation without applying anything.
   *
   * The fail-closed path: call it on interrupt, on session end, on a provider
   * error, on process exit. It can never write to the workspace.
   */
  abandonAll(): Promise<void>;

  /** Ids of the currently open speculations, oldest first. */
  active(): string[];

  /**
   * The innermost (most recently begun) open speculation, or `undefined` when
   * none is open. This is where {@link wrapToolsWithSpeculation} routes writes:
   * the newest pending question is the one the agent is running ahead of.
   */
  current(): Speculation | undefined;
}

/**
 * Tools whose effects a `discard()` can completely undo, and therefore the only
 * ones that may run while a speculation is open (safety rule 2).
 *
 * Deliberately tiny. `bash` is excluded even for something that looks like a
 * pure file edit (`sed -i`), because the overlay cannot redirect a shell
 * command's writes and nothing can un-send whatever else the command did.
 */
const SPECULATABLE_TOOL_NAMES: ReadonlySet<string> = new Set(["write", "edit"]);

/**
 * Read-only tools allowed to keep running while a speculation is open: they
 * observe, they do not mutate, so there is nothing to roll back.
 *
 * `read` is additionally routed through the shadow by
 * {@link wrapToolsWithOverlay}, so the agent sees its own speculative edits.
 * `grep`/`glob`/`ls` take patterns rather than a single path and therefore
 * still see the **real** tree — the same documented boundary dry-run mode has.
 */
const READ_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set(["read", "grep", "glob", "ls"]);

/**
 * Whether a tool's writes are safe to speculate.
 *
 * Conservative by construction: only `write` and `edit`, whose entire effect is
 * a file mutation the overlay can redirect into a shadow and delete again. Every
 * other tool — `bash`, `fetch`, `websearch`, `mcp__*`, sub-agent spawns —
 * answers `false`, because an approval that never comes cannot un-run a command
 * or un-make a network request.
 *
 * @param toolName - Tool definition name.
 * @returns `true` only for tools on the allowlist.
 */
export function isSpeculatable(toolName: string): boolean {
  return SPECULATABLE_TOOL_NAMES.has(toolName);
}

/**
 * Whether a tool may run untouched while a speculation is open because it does
 * not mutate anything.
 *
 * @param toolName - Tool definition name.
 * @param extra - Additional read-only names contributed by the host.
 */
function isReadOnly(toolName: string, extra: ReadonlySet<string>): boolean {
  return READ_ONLY_TOOL_NAMES.has(toolName) || extra.has(toolName);
}

/** Options for {@link wrapToolsWithSpeculation}. */
export interface WrapSpeculationOptions {
  /**
   * Extra tool names that only *read* and may therefore keep running while a
   * speculation is open (host-provided tools, a `symbols` lookup, …).
   *
   * Adding a mutating or network tool here defeats safety rule 2. There is
   * deliberately no option to add a tool to the *speculatable* set.
   */
  readOnly?: readonly string[];
  /**
   * Message handed to the model when a tool is blocked. Defaults to
   * {@link defaultSpeculationBlockMessage}.
   */
  message?: (toolName: string, pending: readonly string[]) => string;
}

/**
 * The default refusal text for a tool blocked by an open speculation. Phrased
 * at the model: keep editing files, or stop and wait — do not retry.
 *
 * @param toolName - Tool that was blocked.
 * @param pending - Ids of the permission requests still awaiting an answer.
 */
export function defaultSpeculationBlockMessage(
  toolName: string,
  pending: readonly string[],
): string {
  const count = pending.length;
  return (
    `Blocked: "${toolName}" cannot run while ${count} permission request${count === 1 ? "" : "s"} ` +
    `(${pending.join(", ")}) ${count === 1 ? "is" : "are"} awaiting the user's answer. ` +
    "File edits made now are speculative and land automatically if the user approves, " +
    `but "${toolName}" has effects that cannot be undone if they deny. ` +
    "Continue with file edits, or wait for the decision before retrying this tool."
  );
}

/**
 * Wrap `tools` so that, **while a speculation is open**:
 *
 * - `write`/`edit` ({@link isSpeculatable}) are redirected into the innermost
 *   speculation's shadow via {@link wrapToolsWithOverlay} — the real file is
 *   never opened for writing;
 * - `read` is served from that shadow when it holds a pending copy, so the
 *   agent sees its own speculative work, and from the real file otherwise;
 * - other read-only tools run untouched;
 * - **everything else is blocked** with an `isError` result (safety rule 2).
 *   The tool's `execute` is never called, so no shell command runs and no
 *   request leaves the machine.
 *
 * With no speculation open every tool runs completely untouched — the wrapper
 * costs one `controller.current()` check per call and changes nothing else, so
 * it is safe to install for the whole session.
 *
 * @param tools - Tools to wrap.
 * @param controller - Controller whose open speculations gate and route them.
 * @param options - Optional extra read-only names and refusal message.
 * @returns Wrapped tools, in input order.
 */
export function wrapToolsWithSpeculation(
  tools: readonly Tool[],
  controller: SpeculationController,
  options: WrapSpeculationOptions = {},
): Tool[] {
  const extraReadOnly: ReadonlySet<string> = new Set(options.readOnly ?? []);
  const message = options.message ?? defaultSpeculationBlockMessage;

  return tools.map((tool) => {
    const name = tool.definition.name;
    // Spread first so extra tool surface (e.g. bindAgent) survives the wrap.
    return {
      ...tool,
      async execute(input: Record<string, unknown>, ctx: ToolExecutionContext) {
        const open = controller.current();
        if (!open) return tool.execute(input, ctx); // Nothing pending: normal behaviour.

        if (isSpeculatable(name) || name === "read") {
          // Reuse the overlay wrapper rather than re-deriving its subtleties
          // (materialize-once, unsheltered pass-through, read fall-through).
          const [redirected] = wrapToolsWithOverlay([tool], open.overlay);
          return (redirected ?? tool).execute(input, ctx);
        }

        if (isReadOnly(name, extraReadOnly)) return tool.execute(input, ctx);

        const pending = controller.active();
        return {
          content: [{ type: "text", text: message(name, pending) }],
          isError: true,
          details: { blockedBySpeculation: true, pendingRequestIds: [...pending] },
        } satisfies ToolResult;
      },
    } satisfies Tool;
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Filesystem-backed {@link SpeculationController}. */
class OverlaySpeculationController implements SpeculationController {
  /** Open speculations, keyed by request id. Insertion order is begin order. */
  readonly #open = new Map<string, Speculation>();
  readonly #overlayFor: (requestId: string) => Overlay;
  /**
   * Serialises the I/O half of settle/abandonAll, so two decisions arriving at
   * once cannot interleave `apply()` and `discard()` — the same promise-queue
   * discipline `checkpoints.ts` uses for its manifest writes.
   */
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: CreateSpeculationOptions) {
    this.#overlayFor = options.overlayFor;
  }

  begin(requestId: string): Speculation {
    const existing = this.#open.get(requestId);
    if (existing) return existing;
    const speculation: Speculation = { requestId, overlay: this.#overlayFor(requestId) };
    this.#open.set(requestId, speculation);
    return speculation;
  }

  active(): string[] {
    return [...this.#open.keys()];
  }

  current(): Speculation | undefined {
    let last: Speculation | undefined;
    for (const speculation of this.#open.values()) last = speculation;
    return last;
  }

  async settle(requestId: string, approved: boolean): Promise<SpeculationOutcome> {
    // With more than one speculation open, a tool call cannot be attributed
    // to the request that authorised it — writes route to whichever is
    // innermost. Applying then risks landing work the user denied elsewhere,
    // so concurrent speculations fail closed: everything is discarded and the
    // outcome says why.
    if (this.#open.size > 1) {
      const speculation = this.#open.get(requestId);
      this.#open.delete(requestId);
      if (speculation) await this.#enqueue(() => this.#resolve(speculation, false));
      return {
        requestId,
        approved,
        status: "discarded",
        applied: [],
        discarded: [],
        errors: [
          {
            path: "",
            message:
              "concurrent permission prompts were open, so speculative work was discarded rather than misattributed",
          },
        ],
      };
    }
    // Close synchronously: from here on no tool can write into this shadow, and
    // a duplicate settle of the same id is a no-op rather than a second apply.
    const speculation = this.#open.get(requestId);
    this.#open.delete(requestId);
    if (!speculation) {
      return {
        requestId,
        approved,
        status: "unknown",
        applied: [],
        discarded: [],
        errors: [],
      };
    }
    return this.#enqueue(() => this.#resolve(speculation, approved));
  }

  async abandonAll(): Promise<void> {
    const pending = [...this.#open.values()];
    this.#open.clear();
    if (pending.length === 0) return;
    // `approved: false` is hard-coded, not passed in: there is no argument that
    // can make this path write to the workspace (safety rule 1).
    await this.#enqueue(async () => {
      for (const speculation of pending) await this.#resolve(speculation, false);
    });
  }

  /**
   * Apply-or-discard one closed speculation. Never throws: every failure comes
   * back as an {@link OverlayApplyError} (safety rule 4).
   */
  async #resolve(speculation: Speculation, approved: boolean): Promise<SpeculationOutcome> {
    const { requestId, overlay } = speculation;
    if (!approved) {
      // Denial: read what we are about to throw away purely so the UI can say
      // it, then delete the shadow. Nothing is written to the workspace.
      let discarded: string[] = [];
      const errors: OverlayApplyError[] = [];
      try {
        discarded = (await overlay.changes()).map((change) => change.path);
      } catch (error) {
        errors.push({
          path: overlay.dir,
          message: `listing discarded changes: ${errorMessage(error)}`,
        });
      }
      try {
        await overlay.discard();
      } catch (error) {
        errors.push({ path: overlay.dir, message: `discarding shadow: ${errorMessage(error)}` });
      }
      return { requestId, approved, status: "discarded", applied: [], discarded, errors };
    }

    let applied: string[] = [];
    let errors: OverlayApplyError[] = [];
    try {
      const result = await overlay.apply();
      applied = [...result.applied];
      errors = [...result.errors];
    } catch (error) {
      // `apply()` collects per-path failures itself, so reaching here means the
      // shadow tree could not even be enumerated. Report it; write nothing.
      errors = [{ path: overlay.dir, message: `applying speculation: ${errorMessage(error)}` }];
    }
    try {
      // The bet is resolved either way: the shadow has no further purpose, and
      // leaving it behind would let a later begin() of the same id inherit it.
      await overlay.discard();
    } catch (error) {
      errors.push({ path: overlay.dir, message: `discarding shadow: ${errorMessage(error)}` });
    }
    return {
      requestId,
      approved,
      status: errors.length === 0 ? "applied" : "partial",
      applied,
      // Anything that failed to apply is gone with the shadow tree — say so.
      discarded: errors.map((error) => error.path),
      errors,
    };
  }

  /** Chain `fn` onto the settle queue so it never overlaps another resolution. */
  #enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#queue.catch(() => undefined).then(fn);
    this.#queue = result.catch(() => undefined);
    return result;
  }
}

/**
 * Create a {@link SpeculationController}.
 *
 * Nothing touches disk until a tool actually writes through an open
 * speculation's overlay: a request the agent never worked ahead of leaves no
 * trace, and `settle` on it is a cheap no-op.
 *
 * @param options - How to build the per-request shadow overlays.
 */
export function createSpeculation(options: CreateSpeculationOptions): SpeculationController {
  return new OverlaySpeculationController(options);
}

/**
 * One-line-per-fact summary of a settled speculation, for the UI: what landed,
 * what was thrown away, and what failed.
 *
 * Paths are shown relative to `cwd` when one is given (the overlay's `cwd`),
 * absolute otherwise.
 *
 * @param outcome - Result of {@link SpeculationController.settle}.
 * @param cwd - Optional workspace root to relativise paths against.
 */
export function formatSpeculationOutcome(outcome: SpeculationOutcome, cwd?: string): string {
  const show = (path: string): string =>
    cwd !== undefined && path.startsWith(cwd) ? relative(cwd, path) || path : path;
  const files = (count: number): string => `${count} file${count === 1 ? "" : "s"}`;
  const lines: string[] = [];

  switch (outcome.status) {
    case "unknown":
      return `Speculation ${outcome.requestId}: nothing was speculated for this request.`;
    case "discarded":
      lines.push(
        outcome.discarded.length === 0
          ? `Speculation ${outcome.requestId}: denied — nothing had been speculated.`
          : `Speculation ${outcome.requestId}: denied — ` +
              `${files(outcome.discarded.length)} discarded, workspace untouched.`,
      );
      for (const path of outcome.discarded) lines.push(`  discarded ${show(path)}`);
      break;
    case "applied":
      lines.push(
        outcome.applied.length === 0
          ? `Speculation ${outcome.requestId}: approved — no speculative changes to land.`
          : `Speculation ${outcome.requestId}: approved — ${files(outcome.applied.length)} landed.`,
      );
      for (const path of outcome.applied) lines.push(`  landed ${show(path)}`);
      break;
    case "partial":
      lines.push(
        `Speculation ${outcome.requestId}: approved — ${files(outcome.applied.length)} landed, ` +
          `${files(outcome.errors.length)} failed and were not written.`,
      );
      for (const path of outcome.applied) lines.push(`  landed ${show(path)}`);
      break;
  }
  for (const error of outcome.errors) lines.push(`  failed ${show(error.path)}: ${error.message}`);
  return lines.join("\n");
}
