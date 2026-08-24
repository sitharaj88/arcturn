/**
 * The permission modal's buttons, and what each one means.
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
