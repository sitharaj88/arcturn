/**
 * Two commands that make an MCP server's resources and prompts usable.
 *
 * `catalog.ts` owns every judgement; this turns those into quick-picks, input
 * boxes and one attachment. The split is the same one `hub/` and `scout/` keep,
 * and for the same reason.
 *
 * ## Attaching goes through the engine, previewing does not
 *
 * "Attach resource" does **not** fetch the resource. It hands the composer a
 * `{ kind: "mcpResource" }` attachment and the engine reads it at prompt time
 * — inside the same byte budget a file gets, in the one place a read is
 * counted. "Preview" is the other path, and exists so a person can look before
 * they attach; what it shows is untrusted text a remote server wrote, so it
 * opens as a plain-text document and never as rendered markdown.
 */

import * as vscode from "vscode";
import {
  argumentsToPrompt,
  isAttachable,
  missingRequired,
  type PromptRow,
  parsePromptCommand,
  promptRow,
  promptText,
  type ResourceRow,
  resourceRow,
} from "./catalog.js";

/** Command ids this module registers. */
export const MCP_COMMANDS = {
  attachResource: "arcturn.mcp.attachResource",
  runPrompt: "arcturn.mcp.runPrompt",
} as const;

/** URI scheme the preview documents are served from. */
export const MCP_PREVIEW_SCHEME = "arcturn-mcp";

/** What these commands need from the engine. */
export interface McpCatalogHost {
  mcpResources(): Promise<{ resources: ResourceRow[] } | undefined>;
  mcpReadResource(server: string, uri: string): Promise<{ contents: { text?: string }[] }>;
  mcpPrompts(): Promise<{ prompts: PromptRow[] } | undefined>;
  mcpGetPrompt(
    server: string,
    name: string,
    args?: Record<string, string>,
  ): Promise<{ messages: { role: string; text: string }[] }>;
  /**
   * Attach a resource to the next prompt, by name.
   *
   * The host never receives the bytes; see this module's doc for why the
   * engine is the one that reads.
   */
  attachResource(server: string, uri: string, label: string): void;
  /** Put text in front of the user for them to send. */
  offerPrompt(text: string): Promise<void>;
}

/** Preview documents, held in memory and served read-only. */
class PreviewDocuments implements vscode.TextDocumentContentProvider {
  readonly #documents = new Map<string, string>();
  readonly #changed = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.#changed.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.#documents.get(uri.toString()) ?? "";
  }

  put(server: string, resourceUri: string, text: string): vscode.Uri {
    const uri = vscode.Uri.parse(
      `${MCP_PREVIEW_SCHEME}:/${encodeURIComponent(server)}/${encodeURIComponent(resourceUri)}`,
    );
    this.#documents.set(uri.toString(), text);
    this.#changed.fire(uri);
    return uri;
  }

  dispose(): void {
    this.#documents.clear();
    this.#changed.dispose();
  }
}

/**
 * Register the two commands and the preview provider.
 *
 * @returns A disposable that removes both and drops every held preview.
 */
export function activateMcpCatalog(
  context: vscode.ExtensionContext,
  host: McpCatalogHost,
): vscode.Disposable {
  const previews = new PreviewDocuments();

  const disposables: vscode.Disposable[] = [
    vscode.workspace.registerTextDocumentContentProvider(MCP_PREVIEW_SCHEME, previews),
    { dispose: () => previews.dispose() },
    vscode.commands.registerCommand(MCP_COMMANDS.attachResource, () =>
      pickAndAttachResource(host, previews),
    ),
    vscode.commands.registerCommand(MCP_COMMANDS.runPrompt, (name?: string) =>
      pickAndRunPrompt(host, name),
    ),
  ];

  const disposable = new vscode.Disposable(() => {
    for (const item of disposables.splice(0)) item.dispose();
  });
  context.subscriptions.push(disposable);
  return disposable;
}

/** Choose a resource, then attach it or look at it first. */
async function pickAndAttachResource(
  host: McpCatalogHost,
  previews: PreviewDocuments,
): Promise<void> {
  const listing = await host.mcpResources();
  if (listing === undefined) {
    void vscode.window.showWarningMessage(
      "This engine is too old to list MCP resources; upgrade the arcturn CLI.",
    );
    return;
  }
  if (listing.resources.length === 0) {
    void vscode.window.showInformationMessage(
      "No MCP server is publishing resources. Configure one in .mcp.json.",
    );
    return;
  }

  const picked = await vscode.window.showQuickPick(
    listing.resources.map((resource) => {
      const row = resourceRow(resource);
      const sendable = isAttachable(resource);
      return {
        ...row,
        // A row that cannot be attached still shows — it can be previewed, and
        // hiding it would look like the server had not published it at all.
        description: sendable ? row.description : `${row.description} · preview only`.trim(),
        resource,
        sendable,
      };
    }),
    { title: "MCP resources", placeHolder: "Which resource?", matchOnDescription: true },
  );
  if (picked === undefined) return;

  const action = await vscode.window.showQuickPick(
    picked.sendable
      ? [
          { label: "Attach to the next message", id: "attach" as const },
          { label: "Preview it first", id: "preview" as const },
        ]
      : [{ label: "Preview it", id: "preview" as const }],
    { title: picked.label },
  );
  if (action === undefined) return;

  if (action.id === "attach") {
    // The engine reads it, at prompt time. Nothing is fetched here.
    host.attachResource(picked.resource.server, picked.resource.uri, picked.label);
    return;
  }

  const read = await host.mcpReadResource(picked.resource.server, picked.resource.uri);
  const text = read.contents
    .map((block) => block.text ?? "(binary content, not shown)")
    .join("\n\n");
  const uri = previews.put(picked.resource.server, picked.resource.uri, text);
  const document = await vscode.workspace.openTextDocument(uri);
  // Opened as plain text on purpose. This is prose a remote server wrote, and
  // rendering it as markdown would give that server a link target inside the
  // user's editor.
  await vscode.window.showTextDocument(document, { preview: true });
}

/** Choose a template, collect its arguments, render it, hand it over. */
async function pickAndRunPrompt(host: McpCatalogHost, named?: string): Promise<void> {
  const listing = await host.mcpPrompts();
  if (listing === undefined) {
    void vscode.window.showWarningMessage(
      "This engine is too old to list MCP prompts; upgrade the arcturn CLI.",
    );
    return;
  }
  if (listing.prompts.length === 0) {
    void vscode.window.showInformationMessage("No MCP server is publishing prompt templates.");
    return;
  }

  // Invoked from the `/` menu, the name arrives as `server:prompt`.
  const requested = named === undefined ? undefined : parsePromptCommand(named);
  const prompt =
    requested === undefined
      ? await choosePrompt(listing.prompts)
      : listing.prompts.find(
          (entry) => entry.server === requested.server && entry.name === requested.prompt,
        );
  if (prompt === undefined) {
    if (requested !== undefined) {
      void vscode.window.showWarningMessage(
        `No MCP server named ${JSON.stringify(requested.server)} publishes a prompt called ` +
          `${JSON.stringify(requested.prompt)}.`,
      );
    }
    return;
  }

  const values: Record<string, string> = {};
  for (const argument of argumentsToPrompt(prompt, { includeOptional: true })) {
    const value = await vscode.window.showInputBox({
      title: `${prompt.server}:${prompt.name}`,
      prompt: argument.description ?? argument.name,
      placeHolder: argument.required
        ? `${argument.name} (required)`
        : `${argument.name} (optional)`,
      ignoreFocusOut: true,
    });
    // Cancelling any box cancels the whole thing. Filling half a template and
    // sending it would be worse than not sending it.
    if (value === undefined) return;
    if (value !== "") values[argument.name] = value;
  }

  const missing = missingRequired(prompt, values);
  if (missing.length > 0) {
    // The server would refuse this too, in its own words. Saying it here names
    // the field instead of quoting a remote error.
    void vscode.window.showWarningMessage(
      `${prompt.server}:${prompt.name} needs ${missing.join(", ")}.`,
    );
    return;
  }

  const rendered = await host.mcpGetPrompt(prompt.server, prompt.name, values);
  const text = promptText(rendered.messages);
  if (text.trim() === "") {
    void vscode.window.showWarningMessage(`${prompt.server}:${prompt.name} rendered to nothing.`);
    return;
  }
  await host.offerPrompt(text);
}

/** The picker, when no name was supplied. */
async function choosePrompt(prompts: readonly PromptRow[]): Promise<PromptRow | undefined> {
  const picked = await vscode.window.showQuickPick(
    prompts.map((prompt) => ({ ...promptRow(prompt), prompt })),
    { title: "MCP prompt templates", placeHolder: "Which template?" },
  );
  return picked?.prompt;
}
