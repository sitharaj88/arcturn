/**
 * Where a permission request is asked, and how it stays answerable.
 *
 * ## Why this is not a modal any more
 *
 * RFC 0005 §2 used to say permission requests stay native modals, and
 * `dialog.ts` called that "a security decision". The threat it was defending
 * against is real but narrow: **spoofing** — model output in the transcript
 * imitating a permission card so that a person clicks a forged Allow.
 *
 * That threat does not survive this codebase. The webview builds every node
 * with `createElement`/`createElementNS` and fills it with `textContent`;
 * there is no `innerHTML` anywhere and `webview-html.test.ts` asserts there is
 * none. Model text therefore becomes text nodes, and a model cannot create a
 * button. The worst it can author is a sentence that says "click Allow below",
 * which is social engineering rather than a forged control.
 *
 * Two properties keep it that way, and both are load-bearing:
 *
 * 1. **A reserved region.** The card is rendered into `#permission`, which
 *    lives in `#dock` beside the composer — never into `#turns`, which is the
 *    only place transcript content is appended. A permission card can
 *    therefore never appear where model text appears, and model text can never
 *    appear where the card does.
 * 2. **Engine-authored content only.** Every string in {@link PermissionCard}
 *    comes from the validated `permissionRequest` payload by way of
 *    {@link describePermissionRequest}, which quotes the engine verbatim. None
 *    of it is transcript text and none of it is composed here.
 *
 * ## The edge a modal never had
 *
 * A modal is visible wherever the user is looking. A panel is not: hidden,
 * collapsed, or in a background container, an inline prompt would mean a run
 * silently blocked on something nobody can see. So the surface is chosen per
 * request and it can change under one:
 *
 * - **Reveal first.** Every ask starts by asking the host to bring the panel
 *   into view (`WebviewView.show(true)` — no focus theft, unlike a modal).
 * - **Card when it worked, modal when it did not.** The host answers whether
 *   the panel is actually visible; a `false` — no view at all, a reveal that
 *   threw, a container that would not open — takes the native modal, because
 *   the one outcome that is not allowed is asking nowhere.
 * - **Escalate if it goes away.** `retainContextWhenHidden` is off (RFC 0004
 *   §3), so hiding the panel destroys the page and the card with it. When the
 *   host reports the view has gone hidden with a request outstanding, the card
 *   is withdrawn and the same request is re-asked as a modal.
 *
 * **One live surface per request, always.** Escalation withdraws before it
 * raises, `#present` refuses to run twice, and an answer from a surface that
 * no longer owns the request is dropped. Two paths that could disagree about
 * what was asked is precisely the failure this design is not allowed to have.
 *
 * ## What did not move
 *
 * The decision rules stayed in `dialog.ts`, where they are testable without a
 * window, and this file calls them for **both** surfaces:
 *
 * - Every outcome that is not an explicit allow is a denial. A dismissed
 *   modal, a failed prompt, a disposal, and a button label this extension does
 *   not recognise all reach {@link answerFromChoice} and all come back
 *   `deny`. The page sends a *label*, never a decision.
 * - "Allow for this session" is offered only when the engine attached a
 *   `suggestedRule`, and the rule persisted is that one, scoped `session`. A
 *   page that presses the session label on a request with no rule gets a plain
 *   allow: the rule is re-derived here from the engine's own request, never
 *   read off the message.
 *
 * Nothing here imports `vscode`; `permission-surface.test.ts` drives the whole
 * state machine with the four host functions injected.
 */

import type { PermissionRequest } from "../serve/engine.js";
import { ALLOW, ALLOW_SESSION, answerFromChoice, DENY, permissionChoices } from "./dialog.js";
import {
  type DescribedPermission,
  describePermissionRequest,
  type PermissionAnswer,
  renderArgs,
} from "./permission-queue.js";

/**
 * One button on the card.
 *
 * `label` is the engine-facing half: it is what {@link permissionChoices}
 * returned and it is what the page sends back, so the host can hand it
 * straight to {@link answerFromChoice} — the same function the modal's answer
 * goes through.
 *
 * `id` is the page-facing half, used for styling and for deciding which button
 * takes focus. The host trusts it for nothing: a decision is derived from the
 * label and from the request, never from this.
 */
export interface PermissionChoice {
  id: "allow" | "allowSession" | "deny";
  label: string;
}

/** A request rendered for the panel's card. Every value comes from the engine. */
export interface PermissionCard {
  /** `PermissionRequest.id`. Echoed back on the answer so a stale page cannot answer for a live request. */
  id: string;
  /** `PermissionRequest.description`, verbatim. */
  description: string;
  /** `PermissionRequest.toolName`, verbatim. */
  tool: string;
  /** `PermissionRequest.subject`, verbatim. */
  subject: string;
  /** The tool's arguments, rendered exactly as the modal renders them. Absent when the engine sent none. */
  args?: string;
  /** `PermissionRequest.origin`, verbatim. Absent for an undelegated call, and then nothing is rendered. */
  origin?: string;
  /** The buttons, in the order the card shows them. */
  choices: PermissionChoice[];
}

/**
 * Project a request into a card.
 *
 * The choices are {@link permissionChoices}' answer and only that — this
 * function does not decide which buttons a request gets, it re-labels them —
 * reordered so **Deny comes first**. That order is the whole accessibility
 * story of the card: DOM order is tab order, the safe answer is what focus
 * lands on, and the primary sits last where the editor puts a confirming
 * action.
 *
 * @param request - The engine's request, unmodified.
 * @param described - The same request as {@link describePermissionRequest}
 *   rendered it, so the card and the modal cannot drift.
 * @param args - The tool's arguments from `toolStart`, when known.
 */
export function permissionCard(
  request: PermissionRequest,
  described: DescribedPermission,
  args?: Record<string, unknown>,
): PermissionCard {
  const offered = permissionChoices(described);
  const choices: PermissionChoice[] = [];
  // Built by asking the answer whether it holds each label, rather than by
  // rebuilding the list: a button this file invented would be a button
  // `answerFromChoice` has never heard of.
  if (offered.includes(DENY)) choices.push({ id: "deny", label: DENY });
  if (offered.includes(ALLOW_SESSION)) choices.push({ id: "allowSession", label: ALLOW_SESSION });
  if (offered.includes(ALLOW)) choices.push({ id: "allow", label: ALLOW });
  const rendered =
    args !== undefined && Object.keys(args).length > 0 ? renderArgs(args) : undefined;
  return {
    id: request.id,
    description: described.message,
    tool: request.toolName,
    subject: request.subject,
    ...(rendered === undefined ? {} : { args: rendered }),
    ...(request.origin === undefined ? {} : { origin: request.origin }),
    choices,
  };
}

/** What {@link PermissionSurface} needs from its embedder (the sidebar, or a test). */
export interface PermissionSurfaceHost {
  /**
   * Bring the panel into view, and say whether it is now visible.
   *
   * `false` is not a failure — it is the answer that routes this request to a
   * modal. A rejection is treated as `false` and reported.
   */
  reveal: () => Promise<boolean>;
  /**
   * Put a card in the panel's reserved region, or take it away with
   * `undefined`. Called at most once per state change, never on a repaint.
   */
  postCard: (card: PermissionCard | undefined) => void;
  /**
   * Raise the native modal for one request.
   *
   * Resolves to the button's label, or `undefined` when it was dismissed —
   * exactly what `vscode.window.showWarningMessage` answers, so the adapter
   * around it has no decision of its own to make.
   */
  askModal: (described: DescribedPermission) => Promise<string | undefined>;
  /** Redacted diagnostics. */
  onDiagnostic?: (line: string) => void;
}

/** Denial used when nothing answered and the surface is going away. */
const ABANDONED: PermissionAnswer = {
  behavior: "deny",
  message: "Denied: the Arcturn panel stopped waiting on this request.",
};

/** One request, and which surface currently owns it. */
interface Pending {
  readonly id: string;
  readonly described: DescribedPermission;
  readonly card: PermissionCard;
  readonly resolve: (answer: PermissionAnswer) => void;
  settled: boolean;
  /** The card is up and may be answered. */
  onPanel: boolean;
  /** A modal has been raised; the card may not answer any more. */
  onModal: boolean;
}

/**
 * Routes one permission request at a time to a surface a person can see.
 *
 * Serialisation is `PermissionQueue`'s job, not this one's: `ask` is called
 * once per request, in arrival order, and the next call cannot arrive until
 * the previous answer has resolved. So at most one request is ever pending
 * here, and "show them in order, answer them in order" is a property of the
 * pair rather than of either half.
 */
export class PermissionSurface {
  readonly #host: PermissionSurfaceHost;
  #pending: Pending | undefined;
  #disposed = false;

  constructor(host: PermissionSurfaceHost) {
    this.#host = host;
  }

  /**
   * Ask a person about one request.
   *
   * @param request - The engine's request, unmodified.
   * @param args - The tool's arguments from `toolStart`, when known.
   * @returns The answer, always. Every path out of here settles: a button, a
   *   dismissed modal, a failed prompt, a hidden panel, a disposal.
   */
  ask(request: PermissionRequest, args?: Record<string, unknown>): Promise<PermissionAnswer> {
    if (this.#disposed) return Promise.resolve(ABANDONED);
    // `PermissionQueue` serialises, so there should be nothing here. If there
    // is, the one thing that must not happen is a promise nobody resolves: the
    // engine would wait on it forever, which is the exact failure every other
    // rule in this file exists to prevent.
    const stale = this.#pending;
    if (stale !== undefined) this.#finish(stale, ABANDONED);
    const described = describePermissionRequest(request, args);
    return new Promise<PermissionAnswer>((resolve) => {
      const pending: Pending = {
        id: request.id,
        described,
        card: permissionCard(request, described, args),
        resolve,
        settled: false,
        onPanel: false,
        onModal: false,
      };
      this.#pending = pending;
      void this.#present(pending);
    });
  }

  /**
   * The page pressed a button.
   *
   * Dropped unless it names the request the card is showing *and* the card
   * still owns it: a reloaded page holding a stale id, or one answering after
   * the request escalated to a modal, must not decide anything.
   *
   * @param requestId - `PermissionRequest.id`, as the card carried it.
   * @param choice - The button's label. Anything unrecognised denies.
   */
  answer(requestId: string, choice: string): void {
    const pending = this.#pending;
    if (pending === undefined || pending.settled) return;
    if (pending.id !== requestId || !pending.onPanel) return;
    this.#finish(pending, answerFromChoice(choice, pending.described));
  }

  /**
   * The panel's visibility changed.
   *
   * Only one direction does anything. Going hidden with a card up destroys the
   * page it was drawn on, so the request is escalated to a modal rather than
   * left waiting on a control that no longer exists. Coming back does *not*
   * pull it out of the modal: the question is already on screen, and moving it
   * would put the same request in two places.
   *
   * @param visible - Whether the panel can be seen.
   */
  setVisible(visible: boolean): void {
    if (visible) return;
    const pending = this.#pending;
    if (pending === undefined || pending.settled || !pending.onPanel) return;
    this.#escalate(pending);
  }

  /**
   * A decision for this request is on the wire, from wherever.
   *
   * Wired to `PermissionQueueOptions.onDecision`, so the card comes down at
   * exactly the moment the request stops being answerable — including the
   * denials `PermissionQueue.dispose` sends for a sidebar that closed while a
   * card was up. Resolving here is harmless when the queue produced the
   * decision itself: it has already recorded the request as answered and
   * ignores what `ask` resolves to.
   *
   * @param requestId - The request that was decided.
   */
  settle(requestId: string): void {
    const pending = this.#pending;
    if (pending === undefined || pending.id !== requestId) return;
    this.#finish(pending, ABANDONED);
  }

  /** Stop asking, take down whatever is up, and deny what was outstanding. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const pending = this.#pending;
    if (pending !== undefined) this.#finish(pending, ABANDONED);
  }

  /**
   * Choose the surface and put the question on it.
   *
   * The reveal is awaited before anything is drawn, which is also the window in
   * which a disposal can land — hence the second `settled` check. A request
   * abandoned mid-reveal shows nothing at all rather than a card for a decision
   * that has already been sent.
   */
  async #present(pending: Pending): Promise<void> {
    let visible = false;
    try {
      visible = await this.#host.reveal();
    } catch (error) {
      this.#report("reveal", error);
      visible = false;
    }
    if (pending.settled || this.#pending !== pending) return;
    if (visible) {
      pending.onPanel = true;
      this.#host.postCard(pending.card);
      return;
    }
    this.#escalate(pending);
  }

  /** Hand a request to the native modal, withdrawing the card first. */
  #escalate(pending: Pending): void {
    if (pending.settled || pending.onModal) return;
    pending.onModal = true;
    if (pending.onPanel) {
      pending.onPanel = false;
      this.#host.postCard(undefined);
    }
    void this.#runModal(pending);
  }

  /**
   * Await the modal, and treat every way it can go wrong as a refusal.
   *
   * `askModal` is wrapped rather than chained because it fronts
   * `showWarningMessage`, which is a Thenable from the workbench: it can reject
   * *or* throw before it returns one, and a `.catch()` alone would only see the
   * first. A prompt that could not be shown is not consent, so both land on the
   * dismissal rule.
   */
  async #runModal(pending: Pending): Promise<void> {
    try {
      const choice = await this.#host.askModal(pending.described);
      this.#finish(pending, answerFromChoice(choice, pending.described));
    } catch (error) {
      this.#report("modal", error);
      this.#finish(pending, answerFromChoice(undefined, pending.described));
    }
  }

  /** Settle one request, once, and clear the region if the card was up. */
  #finish(pending: Pending, answer: PermissionAnswer): void {
    if (pending.settled) return;
    pending.settled = true;
    if (pending.onPanel) {
      pending.onPanel = false;
      this.#host.postCard(undefined);
    }
    if (this.#pending === pending) this.#pending = undefined;
    pending.resolve(answer);
  }

  #report(what: string, error: unknown): void {
    this.#host.onDiagnostic?.(
      `permission ${what}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
