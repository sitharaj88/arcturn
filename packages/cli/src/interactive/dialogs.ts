/**
 * Modal dialogs: the permission prompt, the plan-approval gate and the generic
 * picker used by slash commands.
 *
 * Each builder returns the component to overlay plus a promise that settles
 * when the user chooses (or cancels), so the app can `await` a dialog without
 * owning any of its wiring.
 */

import { Box, type Component, Markdown, SelectList, Text } from "@arcturn/tui";
import type { PermissionRequest, PermissionRule, PermissionScope } from "@arcturn/types";
import type { SelectOption } from "../commands.js";
import { oneLine } from "../format.js";
import { type GlyphSet, resolveGlyphs, toolGlyph } from "../glyphs.js";

/** A dialog: the component to show plus the user's eventual answer. */
export interface DialogHandle<T> {
  /** Component to hand to `TUI.setOverlay`. */
  component: Component;
  /** Resolves with the chosen value, or `undefined` when cancelled. */
  result: Promise<T | undefined>;
}

/** The list plus its footer hint, before being wrapped in a box. */
export interface ChoiceHandle<T> extends DialogHandle<T> {
  /** The keyboard-driven list. */
  list: SelectList<T>;
  /** The `↑↓ select` footer. */
  hint: Text;
}

/** What the user picked in a permission dialog. */
export type PermissionChoice = "once" | "always" | "deny";

/** The subject the plan tool uses when asking to leave plan mode. */
export const EXIT_PLAN_SUBJECT = "exitPlanMode";

/**
 * Build the choice list shared by every dialog.
 *
 * @param options - Rows to offer.
 * @param settings - `filterable` lets printable keys narrow the list.
 */
export function createChoice<T>(
  options: readonly SelectOption<T>[],
  settings: { filterable?: boolean; initialValue?: string } = {},
): ChoiceHandle<T> {
  let settle: (value: T | undefined) => void = () => undefined;
  const result = new Promise<T | undefined>((resolve) => {
    settle = resolve;
  });

  const list = new SelectList<T>({
    items: options.map((option) => ({
      value: option.value,
      ...(option.label === undefined ? {} : { label: option.label }),
      ...(option.description === undefined ? {} : { description: option.description }),
      data: option.data,
    })),
    maxVisible: 10,
    ...(settings.filterable ? { filterable: true } : {}),
    onSelect: (item) => settle(item.data),
    onCancel: () => settle(undefined),
  });
  if (settings.initialValue !== undefined) list.select(settings.initialValue);

  const hint = new Text(
    settings.filterable
      ? "↑↓ select · type to filter · enter confirm · esc cancel"
      : "↑↓ select · enter confirm · esc cancel",
    { style: "muted" },
  );

  return { list, hint, result, component: list };
}

/**
 * Build a generic single-choice picker.
 *
 * @param title - Box title.
 * @param options - Rows to offer.
 * @param settings - `filterable` lets printable keys narrow the list.
 */
export function selectDialog<T>(
  title: string,
  options: readonly SelectOption<T>[],
  settings: { filterable?: boolean; initialValue?: string } = {},
): DialogHandle<T> {
  const choice = createChoice(options, settings);
  return {
    component: new Box([choice.list, choice.hint], {
      title,
      border: "round",
      padding: { x: 1, y: 0 },
    }),
    result: choice.result,
  };
}

/**
 * Suggest the rule offered by the "always allow" option.
 *
 * The runtime suggests an exact-subject rule, which is right for paths but
 * useless for shell commands — approving `git status` would not cover
 * `git diff`. For `bash` the suggestion is therefore widened to a command
 * prefix (`git *`), which is narrow enough that approving `git status` still
 * never approves `rm -rf`.
 *
 * @param request - The permission request being answered.
 */
export function suggestRule(request: Omit<PermissionRequest, "id">): Omit<PermissionRule, "scope"> {
  if (request.subject !== "" && request.toolName === "bash") {
    const head = request.subject.trim().split(/\s+/)[0] ?? request.subject;
    return { tool: "bash", specifier: `${head} *`, action: "allow" };
  }
  if (request.suggestedRule) return request.suggestedRule;
  if (request.subject === "") return { tool: request.toolName, action: "allow" };
  return { tool: request.toolName, specifier: request.subject, action: "allow" };
}

/**
 * Build the permission prompt.
 *
 * When the request carries an `origin` — a `/workflow` role, say — that label
 * leads the dialog, because during a seven-stage org run several roles ask in
 * sequence and an unattributed stream of prompts is indistinguishable from one
 * agent asking over and over (which is exactly what "my permission mode is
 * being ignored" feels like from the outside). A request with no `origin` is
 * the session's own agent asking, and renders exactly as it always has: no
 * label line, nothing moved.
 *
 * @param request - The request to present.
 * @param width - Terminal width, used to size the subject line.
 * @param glyphs - Icon set; the nested-activity connector marks the label.
 * @param scope - How far the "Allow always" row actually reaches. The local
 *   TUI writes a `project` rule to the user's config and says so; `arcturn
 *   attach` is a *remote* client and can only grant `session` (RFC 0005 §1.2 —
 *   nothing persists to disk from a remote client), so it passes `"session"`
 *   and the row says "this session" rather than promising a durable rule the
 *   engine would refuse to write.
 */
export function permissionDialog(
  request: Omit<PermissionRequest, "id">,
  width: number,
  glyphs: GlyphSet = resolveGlyphs(),
  scope: PermissionScope = "project",
): DialogHandle<PermissionChoice> {
  const rule = suggestRule(request);
  const reach = scope === "session" ? "this session" : scope;
  const alwaysLabel = rule.specifier
    ? `Allow always: ${oneLine(`${rule.tool} ${rule.specifier}`, 44)} (${reach})`
    : `Allow always: ${rule.tool} (${reach})`;

  // A session-scoped grant is minted by the ENGINE from the request's own
  // `suggestedRule`, so a request that carries none is not repeatable and the
  // row must not be offered — RFC 0005 §2 puts it exactly that way ("where the
  // engine reports the request is repeatable"), and it is what the VS Code
  // panel's `permissionChoices` already does. The local `project` path is
  // unaffected: there the CLI authors the rule itself and can always offer it.
  const repeatable = scope !== "session" || request.suggestedRule !== undefined;

  const choice = createChoice<PermissionChoice>([
    { value: "once", label: "Allow once", data: "once" },
    ...(repeatable ? [{ value: "always", label: alwaysLabel, data: "always" as const }] : []),
    { value: "deny", label: "Deny and tell the model why", data: "deny" },
  ]);

  const subject = request.subject === "" ? request.toolName : request.subject;
  const tool = new Text(`${toolGlyph(request.toolName, glyphs)} ${request.toolName}`, {
    style: "warning",
  });
  const header = new Text(oneLine(subject, Math.max(20, width - 14)), { style: "title" });
  const body = new Text(oneLine(request.description, 240), { style: "muted" });
  const spacer = new Text("");
  // Prepended, never inserted: an undelegated request produces no element at
  // all, so its dialog keeps the exact line-for-line shape it always had.
  const attribution =
    request.origin === undefined || request.origin === ""
      ? []
      : [
          new Text(`${glyphs.nested} ${oneLine(request.origin, Math.max(20, width - 14))}`, {
            style: "accent",
          }),
        ];

  return {
    component: new Box([...attribution, tool, header, body, spacer, choice.list, choice.hint], {
      title: `${glyphs.permission} Permission required`,
      border: "round",
      borderStyle: "warning",
      titleStyle: "warning",
      padding: { x: 1, y: 0 },
    }),
    result: choice.result,
  };
}

/**
 * Build the plan-approval gate shown when the model calls `plan` in plan mode.
 *
 * @param plan - Plan markdown, taken from the request description.
 */
export function planDialog(
  plan: string,
  glyphs: GlyphSet = resolveGlyphs(),
): DialogHandle<PermissionChoice> {
  const choice = createChoice<PermissionChoice>([
    { value: "once", label: "Approve — start making changes", data: "once" },
    { value: "always", label: "Approve and auto-accept edits", data: "always" },
    { value: "deny", label: "Keep planning", data: "deny" },
  ]);
  const markdown = new Markdown(plan, { paddingX: 0 });
  const spacer = new Text("");
  return {
    component: new Box([markdown, spacer, choice.list, choice.hint], {
      title: `${glyphs.plan} Plan ready`,
      border: "round",
      titleStyle: "accent",
      padding: { x: 1, y: 0 },
    }),
    result: choice.result,
  };
}
