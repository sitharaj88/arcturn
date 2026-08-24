/**
 * What the sidebar shows when there is no engine, and what it offers to do
 * about it.
 *
 * RFC 0004 §1: "Serve dying → sidebar shows a reconnect card, never a stack
 * trace." The card was doing half of that. This module is the other half: a
 * failed start is not the same event as an outage, and neither of them is
 * actionable if the only button is *Reconnect* — retrying a `serve` that
 * refused to start over a missing API key just fails again, faster.
 *
 * ## Two rules
 *
 * **The engine's words are quoted, not paraphrased.** The most common failure
 * on a GUI-launched editor is:
 *
 * ```
 * arcturn: No API key found for Claude Sonnet 4.5 (anthropic/claude-sonnet-4-5).
 * Set ANTHROPIC_API_KEY in your environment, or pick another model with --model.
 * ```
 *
 * That is already a complete, correct, actionable message — written by the
 * part of the system that actually knows which credential is missing. The
 * extension has no catalog of providers and no business inventing a second
 * wording for it, so {@link ConnectionReport.engineOutput} carries it through
 * verbatim (redacted, and rendered as text — see `webview-client.ts`). It is
 * the same discipline the permission modal follows with tool arguments.
 *
 * **The extension speaks only for itself.** {@link ConnectionReport.headline}
 * says what *the extension* observed — the engine could not start, the engine
 * stopped, the binary is missing — and never restates the engine's reason. If
 * the engine said nothing, the headline is all there is, and it says so with
 * the exit code rather than with a guess.
 *
 * ## Why the extension does not pre-check credentials
 *
 * `listModels` reports `credentials: present | absent | unknown` per model, so
 * it is tempting to ask the engine up front whether anything is usable and
 * refuse to start rather than letting `serve` fail. It is not done, for two
 * reasons. `listModels` is answered *by a running server*, which is exactly
 * what does not exist on this path — so the check would have to be a second,
 * local copy of the engine's provider→variable table, drifting the moment a
 * provider is added, and RFC 0004 §0 is explicit that the protocol is the only
 * boundary. And the engine's refusal is better than anything that table could
 * produce: it names the model, its display name, and the exact variable to
 * set. Quoting it is both more accurate and less code.
 *
 * Where the catalog *is* available — a connected session — the model picker
 * already renders `credentials` per row and sorts the models with a key first
 * (`picker.ts`). That is the proactive half, in the place it can be honest.
 *
 * Pure and `vscode`-free: a report is data, and every rule about which button
 * appears when is testable without an editor.
 */

import type { ServeStartFailure } from "../serve/supervisor.js";

/**
 * The actions the card may offer.
 *
 * A closed list, because it doubles as the validation table for the webview
 * boundary (`webview-messages.ts`): a `postMessage` from the page can only ask
 * for one of these five, so a compromised webview cannot name an arbitrary
 * VS Code command and have the host run it.
 */
export const CONNECTION_ACTIONS = [
  "reconnect",
  "showLog",
  "installCli",
  "openCliSetting",
  "openModelSetting",
] as const;

/** One of {@link CONNECTION_ACTIONS}. */
export type ConnectionActionId = (typeof CONNECTION_ACTIONS)[number];

/** A button on the card. */
export interface ConnectionAction {
  readonly id: ConnectionActionId;
  /** The extension's own words; never engine input, so never rendered as one. */
  readonly label: string;
}

/** Everything the card needs to render one failure. */
export interface ConnectionReport {
  /** One line, the extension's account of what it observed. */
  readonly headline: string;
  /** The engine's own words, verbatim and redacted. `""` when it said nothing. */
  readonly engineOutput: string;
  /** Buttons, most useful first. Always ends with `reconnect`. */
  readonly actions: ConnectionAction[];
}

const LABELS: Record<ConnectionActionId, string> = {
  reconnect: "Retry",
  showLog: "Show Log",
  installCli: "Install CLI",
  openCliSetting: "Set CLI Path",
  openModelSetting: "Choose a Model",
};

function actions(...ids: ConnectionActionId[]): ConnectionAction[] {
  return ids.map((id) => ({ id, label: LABELS[id] }));
}

/** `with code 2`, `on SIGKILL`, or nothing the platform could tell us. */
function describeExit(failure: ServeStartFailure): string {
  if (failure.signal !== null) return `on ${failure.signal}`;
  if (failure.code !== null) return `with code ${String(failure.code)}`;
  return "without reporting a status";
}

/**
 * Build the card for a `serve` that never announced an address.
 *
 * @param failure - The structured failure from `startServeProcess`.
 */
export function startFailureReport(failure: ServeStartFailure): ConnectionReport {
  const quoted = failure.stderr.trim();
  switch (failure.reason) {
    case "spawn":
      return {
        headline:
          "The Arcturn engine could not start: the arcturn binary could not be run. Check " +
          "arcturn.cliPath, or install the CLI.",
        engineOutput: quoted,
        actions: actions("openCliSetting", "installCli", "showLog", "reconnect"),
      };
    case "timeout":
      return {
        headline:
          "The Arcturn engine could not start: it was launched but never reported an address.",
        engineOutput: quoted,
        actions: actions("showLog", "reconnect"),
      };
    case "address":
      return {
        headline:
          "The Arcturn engine could not start: it bound an address that is not loopback, so no " +
          "token was handed to it.",
        engineOutput: quoted,
        actions: actions("showLog", "reconnect"),
      };
    default:
      return {
        headline:
          quoted === ""
            ? `The Arcturn engine could not start: arcturn serve exited ${describeExit(failure)} without explaining why.`
            : `The Arcturn engine could not start. arcturn serve exited ${describeExit(failure)} and said:`,
        engineOutput: quoted,
        // The model setting is offered because the engine's own most common
        // refusal here names a model and a credential, and switching models is
        // the fix the engine itself suggests. It is offered, not applied: the
        // extension does not know which model the user can afford to use.
        actions: actions("showLog", "openModelSetting", "reconnect"),
      };
  }
}

/**
 * Build the card for "there is no engine binary to start".
 *
 * @param detail - The extension's own explanation, from `cli-resolve.ts`.
 */
export function missingCliReport(detail: string): ConnectionReport {
  return {
    headline: detail,
    engineOutput: "",
    actions: actions("installCli", "openCliSetting", "showLog", "reconnect"),
  };
}

/**
 * Build the card for an engine that was running and is not any more.
 *
 * Distinct from {@link startFailureReport} because the user's question is
 * different: a session existed, and *Retry* is a reasonable first move rather
 * than a loop.
 *
 * @param detail - The engine's last words, or the extension's account of the
 *   socket closing.
 */
export function outageReport(detail: string): ConnectionReport {
  return {
    headline: "The Arcturn engine stopped.",
    engineOutput: detail.trim(),
    actions: actions("showLog", "reconnect"),
  };
}

/**
 * The report as one block of text — what the Output channel records and what a
 * notification shows when the sidebar is not the surface the user is on.
 *
 * @param report - The card.
 */
export function reportText(report: ConnectionReport): string {
  return report.engineOutput === ""
    ? report.headline
    : `${report.headline}\n${report.engineOutput}`;
}
