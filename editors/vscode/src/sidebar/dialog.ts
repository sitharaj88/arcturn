/**
 * The modal dialogs' buttons, and what each one means.
 *
 * Split out of the `vscode` adapter so the decision — which is a security
 * decision — is testable without a window. The rules:
 *
 * - "Allow always" is offered **only** when the engine attached a
 *   `suggestedRule`. The extension never invents a rule to persist; it can
 *   only offer the one the engine already computed.
 * - Every outcome that is not an explicit allow is a **denial**. A dismissed
 *   modal (Escape, or VS Code's own Cancel) and an unrecognised button both
 *   deny, because the alternative — treating "no answer" as consent — is the
 *   one failure mode a permission system may not have.
 */

import type { DescribedPermission, PermissionAnswer } from "./permission-queue.js";

/** Button: run it once. */
export const ALLOW = "Allow";
/** Button: run it, and persist the engine's suggested rule for this session. */
export const ALLOW_ALWAYS = "Allow always";
/** Button: refuse. */
export const DENY = "Deny";

/**
 * The buttons to show for one request.
 *
 * @param described - The rendered request.
 */
export function permissionChoices(described: DescribedPermission): string[] {
  return described.suggestedRule === undefined ? [ALLOW, DENY] : [ALLOW, ALLOW_ALWAYS, DENY];
}

/**
 * Turn the user's choice into a decision.
 *
 * @param choice - The button label, or `undefined` when the modal was dismissed.
 * @param described - The rendered request, for its suggested rule.
 */
export function answerFromChoice(
  choice: string | undefined,
  described: DescribedPermission,
): PermissionAnswer {
  if (choice === ALLOW) return { behavior: "allow" };
  if (choice === ALLOW_ALWAYS) {
    return described.suggestedRule === undefined
      ? { behavior: "allow" }
      : { behavior: "allow", persistRule: described.suggestedRule };
  }
  if (choice === DENY) {
    return { behavior: "deny", message: "Denied by the user in VS Code." };
  }
  return { behavior: "deny", message: "Denied: the permission dialog was dismissed in VS Code." };
}

/** Button: delete the session, for good. */
export const DELETE_SESSION = "Delete";

/** The modal shown before a session is deleted. */
export interface DeleteSessionPrompt {
  /** The question, naming the session. */
  message: string;
  /** What deleting actually does. */
  detail: string;
  /** The only label that means yes. */
  confirmLabel: string;
}

/**
 * The confirmation for a delete.
 *
 * Here rather than inline in the `vscode` adapter for the same reason the
 * permission buttons are: the decision is the dangerous part, and it should be
 * testable without a window. Deleting a session is irreversible and the
 * control that triggers it sits in a list of rows a user is clicking through,
 * so the modal has two jobs — name *which* session, and say that it does not
 * come back.
 *
 * @param label - The session's title, or its id when it has no title. Already
 *   escaped by the caller if it is going into a `showWarningMessage`.
 */
export function describeSessionDeletion(label: string): DeleteSessionPrompt {
  return {
    message: `Delete the Arcturn session "${label}"?`,
    detail:
      "This permanently deletes the conversation and everything in it, for every client of this engine. It cannot be undone.",
    confirmLabel: DELETE_SESSION,
  };
}

/**
 * Whether the user actually said yes.
 *
 * Same rule the permission dialog uses, and for the same reason: everything
 * that is not an explicit confirmation is a refusal. A dismissed modal
 * (Escape, VS Code's own Cancel) and an unrecognised button both mean *do not
 * delete* — treating "no answer" as consent is the one failure mode a
 * destructive action may not have.
 *
 * @param choice - The button label, or `undefined` when the modal was dismissed.
 * @param prompt - The prompt that was shown.
 */
export function confirmsSessionDeletion(
  choice: string | undefined,
  prompt: DeleteSessionPrompt,
): boolean {
  return choice !== undefined && choice === prompt.confirmLabel;
}
