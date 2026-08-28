/**
 * What an MCP server publishes, as rows a person can choose from.
 *
 * MCP has three halves — tools, resources, prompt templates — and Arcturn used
 * one. A Figma server could be *called* but the frame it publishes could not be
 * attached; a Linear server's "triage this issue" template was invisible. The
 * engine grew the verbs; this turns their answers into pickable rows.
 *
 * Pure by construction, for the reason `hub/tree.ts` is: the judgements worth
 * testing — what a row says, which arguments a template still needs, whether
 * a resource is attachable at all — should not need an extension host to
 * check.
 *
 * ## Everything here is text a remote server wrote
 *
 * The engine sanitizes descriptions on the way out (first line, control
 * characters collapsed, capped) precisely because they land here. This module
 * adds the second half of that rule: rows are built as **plain strings**, and
 * nothing in this file produces markdown or HTML from a server's text. A
 * tooltip that rendered a description as markdown would hand a remote server a
 * link target in the user's editor.
 */

/** One resource an MCP server publishes. */
export interface ResourceRow {
  readonly server: string;
  readonly uri: string;
  readonly name?: string;
  readonly description?: string;
  readonly mimeType?: string;
}

/** One prompt template an MCP server publishes. */
export interface PromptRow {
  readonly server: string;
  readonly name: string;
  readonly description?: string;
  readonly arguments?: readonly {
    readonly name: string;
    readonly description?: string;
    readonly required?: boolean;
  }[];
}

/** A row as a quick-pick shows it. */
export interface PickRow {
  readonly label: string;
  readonly description: string;
  readonly detail: string;
}

/**
 * What to call a resource in a list.
 *
 * The server's name when it gave one, the URI otherwise — never both in the
 * label, because a label long enough to be truncated is a label nobody can
 * tell apart from its neighbour. The URI goes in `description`, where it is
 * still visible and still copyable.
 */
export function resourceRow(resource: ResourceRow): PickRow {
  return {
    label: resource.name ?? resource.uri,
    description: resource.name === undefined ? "" : resource.uri,
    detail: resource.description ?? "",
  };
}

/**
 * What to call a prompt template in a list.
 *
 * Prefixed `server:` because a prompt name is unique only per server — two
 * servers may both publish `review`, and a list showing one row would be
 * hiding the other rather than resolving it.
 */
export function promptRow(prompt: PromptRow): PickRow {
  const required = (prompt.arguments ?? []).filter((argument) => argument.required);
  const shape =
    prompt.arguments === undefined || prompt.arguments.length === 0
      ? "no arguments"
      : `${prompt.arguments.length} arguments, ${required.length} required`;
  return {
    label: `${prompt.server}:${prompt.name}`,
    description: shape,
    detail: prompt.description ?? "",
  };
}

/**
 * Which arguments still have to be asked for.
 *
 * Required ones always; optional ones only when the caller says to. A form
 * that demanded every optional argument would be a form nobody finishes, and
 * one that skipped a required argument would send a template the server
 * refuses — so the split is the whole decision.
 */
export function argumentsToPrompt(
  prompt: PromptRow,
  options: { readonly includeOptional?: boolean } = {},
): { name: string; description?: string; required: boolean }[] {
  return (prompt.arguments ?? [])
    .filter((argument) => argument.required === true || options.includeOptional === true)
    .map((argument) => ({
      name: argument.name,
      ...(argument.description === undefined ? {} : { description: argument.description }),
      required: argument.required === true,
    }));
}

/**
 * Whether the collected values are enough to render the template.
 *
 * Checked before the round trip rather than after: a server rejecting a
 * template for a missing argument is a failure the client could have seen
 * coming, and its message is the server's prose rather than a form label.
 */
export function missingRequired(
  prompt: PromptRow,
  values: Readonly<Record<string, string>>,
): string[] {
  return (prompt.arguments ?? [])
    .filter((argument) => argument.required === true)
    .map((argument) => argument.name)
    .filter((name) => (values[name] ?? "") === "");
}

/**
 * Flatten a rendered template into the text that goes in the composer.
 *
 * Roles are dropped rather than rendered. A template's messages are a
 * conversation the *server* imagined, and replaying its `assistant` turns as
 * though Arcturn had said them would be putting words in the agent's mouth —
 * so what the user gets is the material, and the turn is theirs to send.
 */
export function promptText(messages: readonly { role: string; text: string }[]): string {
  return messages
    .map((message) => message.text)
    .filter((text) => text.trim() !== "")
    .join("\n\n");
}

/**
 * Parse a `/server:name` command back into its two halves.
 *
 * `listCommands` names MCP prompts this way, so a `/` menu can offer them
 * beside skills. A name with no colon is not one of them.
 */
export function parsePromptCommand(name: string): { server: string; prompt: string } | undefined {
  const colon = name.indexOf(":");
  if (colon <= 0 || colon === name.length - 1) return undefined;
  return { server: name.slice(0, colon), prompt: name.slice(colon + 1) };
}

/**
 * Whether a resource can be attached to a prompt.
 *
 * A resource with no text is one the engine would inject as a placeholder, and
 * a row that leads to "(binary content, not included)" is worse than a row
 * that says up front it cannot be sent. MIME is the only evidence available
 * before reading, so it is what the answer is built from — and an absent MIME
 * is treated as attachable, because a server that declared nothing is far more
 * likely to be serving text than to be serving a PNG it forgot to label.
 */
export function isAttachable(resource: ResourceRow): boolean {
  const mime = resource.mimeType;
  if (mime === undefined || mime === "") return true;
  return (
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime.endsWith("+json") ||
    mime.endsWith("+xml")
  );
}
