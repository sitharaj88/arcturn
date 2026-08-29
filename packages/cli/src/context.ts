/**
 * The served engine's context resolver — RFC 0005 §1.1, wired.
 *
 * `expandMentions` has always run in `print.ts` and the TUI. A prompt arriving
 * over `arcturn serve` was passed to the agent verbatim, so `@src/auth.ts`
 * reached the model as six words about a file rather than the file, and every
 * remote client — the VS Code panel, `arcturn attach`, the browser page — was
 * silently degraded. This module is what `createServeHost` injects to close
 * that, and it deliberately implements *nothing* that already exists:
 *
 * - Mentions expand by calling {@link expandMentions}, the same function the
 *   TUI calls, so the two cannot diverge.
 * - Confinement is {@link confineToWorkspace}, the same gate mentions have
 *   always used — RFC 0005 §1.1 asks the served path to inherit "the strictest
 *   existing rule rather than a new one", and a second implementation is how a
 *   rule stops being the strictest.
 * - A file is read by {@link readContextFile}, so an attachment and a mention
 *   share one set of size caps and one truncation marker.
 * - A leading `/name` expands through {@link expandServedCommand}, which drives
 *   the same {@link Skill.buildPrompt} the TUI's `/name` and the model-invoked
 *   `skill` tool drive — RFC 0005 §1.3, and the same argument one more time.
 *
 * What is new here is only what the wire adds: attachments, a total byte
 * budget, and an honest read-only answer for a file picker.
 *
 * ## Why a command and a mention share this one seam
 *
 * They are the same job — "turn what the client typed into what the model is
 * handed, before a turn is spent" — and they have to be *ordered* against each
 * other, which can only be decided in one place. Splitting them would leave
 * that order implicit in whichever ran first. Here it is explicit: a prompt is
 * either a command or it is prose, never both, and `serve-commands.ts` records
 * why (a skill body's mentions stay unexpanded, exactly as in the terminal).
 */

import { stat } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";
import {
  type ContextQueryRequest,
  ContextRefusedError,
  type ContextResolver,
  PROMPT_ATTACHMENT_MAX_BYTES,
  type PromptContextRequest,
  type ResolvedImage,
  type ResolvedPrompt,
} from "@arcturn/server";
import type { ContextKind, ContextResolution, PromptAttachmentKind } from "@arcturn/types";
import {
  confineToWorkspace,
  expandMentions,
  IMAGE_MIME_TYPES,
  readContextFile,
} from "./mentions.js";
import { expandServedCommand } from "./serve-commands.js";
import type { Skill } from "./skills.js";

/** Construction options for {@link createContextResolver}. */
export interface ContextResolverOptions {
  /**
   * Total byte budget for one prompt's attachments. Defaults to
   * {@link PROMPT_ATTACHMENT_MAX_BYTES}.
   *
   * Injectable for the reason `SessionHostOptions.sessionHistoryLimits` is: so
   * a test can prove the cap actually cuts without first writing a megabyte of
   * attachments to a scratch directory.
   */
  maxAttachmentBytes?: number;
  /**
   * The discovered markdown skills a leading `/name` resolves against.
   *
   * A getter rather than an array, matching `SessionHostOptions.commands` and
   * `modelCatalog`: skills do not reload after startup today, but a future
   * watcher must not need this wiring changed to be picked up. Omitted — a
   * stub runtime, an embedder with no skill library — every command attempt
   * finds nothing and is refused as unknown, which is the truth for such a
   * host.
   *
   * `createServeHost` passes the very same closure it passes to `commands`, so
   * the menu and the expander read one array. Two closures over one array is
   * how a menu comes to list a skill the expander cannot find.
   */
  skills?: () => readonly Skill[];
  /**
   * Reads one MCP resource, for a `{ kind: "mcpResource" }` attachment.
   *
   * A function rather than the manager itself, for the reason `skills` is a
   * getter: this module has no business depending on `@arcturn/mcp`, and a
   * host without MCP servers should be able to omit it and have such an
   * attachment refused rather than silently dropped.
   */
  readMcpResource?: (server: string, uri: string) => Promise<string>;
}

/**
 * How many bytes a base64 string decodes to, without decoding it.
 *
 * Counted rather than decoded because the count is what decides whether to
 * decode at all: `Buffer.from(data, "base64")` on a hostile 100 MB string
 * allocates 75 MB before anyone gets to refuse it.
 */
function base64Bytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

/**
 * The one line a `fileReference` puts in front of the model.
 *
 * Three things it has to do, and one it has to avoid:
 *
 * - **Name the path**, in the workspace-relative spelling every other surface
 *   uses, so the model can hand it straight to `read`.
 * - **Say the contents are not here**, in words, because a bare path next to a
 *   prompt is exactly what a model reads as "and here is the file".
 * - **Say what to do about it** — the agent has a `read` tool, and the whole
 *   trade is "one turn's read when it matters, instead of every turn's
 *   injection on spec".
 * - And **not look like a context block.** No fenced body, no `(attached
 *   file)` heading, no trailing colon: those three are what
 *   {@link readContextFile} emits for content that *is* present, and a
 *   reference that borrowed any of them would be a reference the model
 *   answers from.
 *
 * @param relativePath - The confined, workspace-relative path.
 */
function referenceLine(relativePath: string): string {
  return (
    `\n\n${relativePath} (referenced file — the client named this path as relevant context; ` +
    "its contents were not read and are not included here. Use the read tool to open it if " +
    "this turn needs it.)"
  );
}

/**
 * The {@link PromptAttachment} kinds this resolver honours, advertised on every
 * `resolveContext` answer.
 *
 * Written out here rather than derived from the type, because the honest
 * answer is "what the code below actually implements" and a derived list would
 * claim support for a kind the moment somebody added it to the union and
 * before anybody taught `buildPrompt` what to do with it.
 */
const ATTACHMENT_KINDS: readonly PromptAttachmentKind[] = ["file", "fileReference", "image"];

/** The message a client is refused with when its attachments do not fit. */
function budgetMessage(what: string, bytes: number, limit: number): string {
  return (
    `Attachment ${what} does not fit: ${String(bytes)} bytes would put this prompt over the ` +
    `${String(limit)}-byte total attachment budget. Attach fewer, or smaller, files.`
  );
}

/**
 * Build the resolver `createServeHost` injects into its {@link SessionHost}.
 *
 * @param options - See {@link ContextResolverOptions}.
 */
export function createContextResolver(options: ContextResolverOptions = {}): ContextResolver {
  const maxBytes = options.maxAttachmentBytes ?? PROMPT_ATTACHMENT_MAX_BYTES;
  const skills = options.skills ?? ((): readonly Skill[] => []);
  const readMcpResource = options.readMcpResource;

  return {
    async buildPrompt(request: PromptContextRequest): Promise<ResolvedPrompt> {
      // A command first, because a command is not prose: when the prompt is
      // `/review src`, there is no user-typed mention in it to expand, and
      // running `expandMentions` over the skill body afterwards would hand a
      // repository-controlled file the mention channel. See
      // `serve-commands.ts` for that decision in full.
      const command = expandServedCommand(request.text, skills(), request.cwd);
      if (command.outcome === "refused") {
        // Fatal, like a bad attachment and unlike a bad mention: the client
        // named a command, and answering the model with the literal text
        // `/reviw the auth module` is the silent no-op RFC 0005 §3 forbids.
        throw new ContextRefusedError(command.reason);
      }
      const expanded =
        command.outcome === "expanded"
          ? { text: command.text, images: [], imagePaths: [] as string[], refusals: [] }
          : await expandMentions(request.text, request.cwd);
      const images: ResolvedImage[] = expanded.images.map((content, index) => ({
        content,
        source: "mention",
        label: expanded.imagePaths[index] ?? "an image",
      }));
      const appended: string[] = [];
      let spent = 0;

      for (const attachment of request.attachments) {
        if (attachment.kind === "mcpResource") {
          // Named by the client, fetched here. The read is the engine's for
          // the reason every other read is — this is where the budget lives,
          // and a client that fetched its own copy would be spending tokens
          // nobody counted. See `PromptAttachment` for the whole rule.
          if (readMcpResource === undefined) {
            throw new ContextRefusedError(
              `Attachment ${JSON.stringify(attachment.uri)} names an MCP resource, and this ` +
                "engine has no MCP servers configured.",
            );
          }
          let text: string;
          try {
            text = await readMcpResource(attachment.server, attachment.uri);
          } catch (error) {
            // Fatal, like an unconfined path: the user asked for this content,
            // and running the turn without it is a silent drop.
            throw new ContextRefusedError(
              `Attachment ${JSON.stringify(attachment.uri)} could not be read from MCP server ` +
                `${JSON.stringify(attachment.server)}: ` +
                `${error instanceof Error ? error.message : String(error)}`,
            );
          }
          const heading = `${attachment.server}: ${attachment.uri} (MCP resource)`;
          const block = `${heading}\n\n\`\`\`\n${text}\n\`\`\``;
          const bytes = Buffer.byteLength(block, "utf8");
          spent += bytes;
          if (spent > maxBytes) {
            throw new ContextRefusedError(budgetMessage(attachment.uri, bytes, maxBytes));
          }
          appended.push(block);
          continue;
        }
        if (!("path" in attachment)) {
          // An image with no path: a paste, a drop from outside the filesystem.
          // Nothing to confine — it was never a workspace file — so the only
          // gates are the budget and the media type. See `PromptAttachment`.
          const bytes = base64Bytes(attachment.data);
          spent += bytes;
          if (spent > maxBytes) {
            throw new ContextRefusedError(budgetMessage("(pasted image)", bytes, maxBytes));
          }
          if (!Object.values(IMAGE_MIME_TYPES).includes(attachment.mimeType)) {
            throw new ContextRefusedError(
              `Attachment media type ${JSON.stringify(attachment.mimeType)} is not one this ` +
                `engine can send (${[...new Set(Object.values(IMAGE_MIME_TYPES))].join(", ")}).`,
            );
          }
          images.push({
            content: { type: "image", data: attachment.data, mimeType: attachment.mimeType },
            source: "attachment",
            label: "a pasted image",
          });
          continue;
        }

        const verdict = await confineToWorkspace(request.cwd, attachment.path);
        if (verdict.outcome !== "inside") {
          // Fatal, unlike the same verdict on a mention: the client named this
          // file, so running the turn without it is the silent drop RFC 0005
          // §1.1 forbids. Nothing was read either way.
          throw new ContextRefusedError(
            `Attachment ${JSON.stringify(attachment.path)} ${verdict.reason}.`,
          );
        }

        if (attachment.kind === "fileReference") {
          // A reference is read *about*, never read. Everything above still
          // ran — confinement, and fatally — because a client that could name
          // an unconfined path in the prompt would have moved the disclosure
          // even though it could not move the read.
          //
          // It is still stat'ed, for one reason: a line telling the model that
          // `src/auth.ts` is in play, when nothing is there, sends it to spend
          // a `read` on nothing and then reason about the absence. The stat is
          // the whole cost, and `confineToWorkspace` has already made one.
          let isFile: boolean;
          try {
            isFile = (await stat(verdict.realPath)).isFile();
          } catch {
            isFile = false;
          }
          if (!isFile) {
            throw new ContextRefusedError(
              `Attachment ${JSON.stringify(attachment.path)} is not a file.`,
            );
          }
          const line = referenceLine(verdict.relativePath);
          // Charged like everything else, from what the model actually sees:
          // about 190 bytes, against the 80 KB the same file costs as an
          // attachment. That gap is the entire point — but a client sending
          // ten thousand references is still sending a prompt, and the budget
          // is the one place that is decided.
          const bytes = Buffer.byteLength(line, "utf8");
          spent += bytes;
          if (spent > maxBytes) {
            throw new ContextRefusedError(budgetMessage(verdict.relativePath, bytes, maxBytes));
          }
          appended.push(line);
          continue;
        }

        const heading =
          attachment.kind === "image"
            ? verdict.relativePath
            : `${verdict.relativePath} (attached file)`;
        // The range goes to the same reader, so an excerpt inherits the same
        // caps and the same truncation marker a whole file gets — RFC 0005 §3
        // asks for one reader, and a second one that sliced would be a second
        // set of numbers to drift.
        const range = attachment.kind === "file" ? attachment.range : undefined;
        const content = await readContextFile(verdict.realPath, heading, range);

        if (content.kind === "notAFile") {
          throw new ContextRefusedError(
            `Attachment ${JSON.stringify(attachment.path)} is not a file.`,
          );
        }
        if (content.kind === "rangeRefused") {
          // Fatal, like every other attachment refusal: the client named those
          // lines, and injecting the whole file instead — or nothing — would be
          // the silent substitution a range exists to prevent.
          throw new ContextRefusedError(
            `Attachment ${JSON.stringify(attachment.path)} ${content.reason}.`,
          );
        }
        if (content.kind === "tooLarge") {
          throw new ContextRefusedError(
            `Attachment ${JSON.stringify(attachment.path)} is ${String(content.bytes)} bytes, ` +
              `past this engine's ${String(content.limit)}-byte ceiling for one attachment.`,
          );
        }

        // Charged after the read, from what was actually read: `readContextFile`
        // truncates a long text file, and charging a client for bytes the model
        // never sees would make the budget mean something it does not.
        const bytes =
          content.kind === "image"
            ? base64Bytes(content.content.data)
            : Buffer.byteLength(content.text, "utf8");
        spent += bytes;
        if (spent > maxBytes) {
          throw new ContextRefusedError(budgetMessage(verdict.relativePath, bytes, maxBytes));
        }

        if (content.kind === "image") {
          images.push({
            content: content.content,
            source: "attachment",
            label: verdict.relativePath,
          });
        } else {
          appended.push(content.text);
        }
      }

      return {
        text: expanded.text + appended.join(""),
        images,
        refusals: expanded.refusals.map((refusal) => ({
          what: refusal.what,
          reason: refusal.reason,
        })),
      };
    },

    async resolve(request: ContextQueryRequest): Promise<ContextResolution> {
      // A client may send the mention as typed. Stripping the `@` here means a
      // picker does not have to know whether the engine wants it, and a real
      // file whose name starts with `@` is still reachable by quoting it the
      // way a mention does.
      const raw = request.query.startsWith("@") ? request.query.slice(1) : request.query;
      const verdict = await confineToWorkspace(request.cwd, raw === "" ? "." : raw);
      // Echoed on every answer a range was asked about, whatever the path turns
      // out to be. It is a capability signal and nothing more — "this engine
      // understood the parameter" — which is exactly what a client needs before
      // it trusts a ranged attachment not to arrive as a whole file. It says
      // nothing about whether the range *fits*: this verb stats and never
      // reads, and a file's line count cannot be known without reading it. See
      // `ContextResolution.range`.
      const echo = request.range === undefined ? {} : { range: request.range };
      // Stated on *every* answer, unconditionally, because it is a fact about
      // this engine rather than about the query — and because a client asks
      // this question exactly once, on a probe it has to be able to make
      // against any path. An engine that predates the field omits it, which a
      // client reads as the two kinds that shipped with `attachments`; see
      // `ContextResolution.attachmentKinds`.
      const kinds: Pick<ContextResolution, "attachmentKinds"> = {
        attachmentKinds: ATTACHMENT_KINDS,
      };

      if (verdict.outcome === "outside") {
        // No stat, deliberately: answering "does this exist" for a path the
        // engine refuses to read would turn a read-only preview verb into a
        // filesystem oracle for exactly the paths confinement exists to hide.
        return {
          query: request.query,
          ...echo,
          ...kinds,
          path: verdict.path,
          relativePath: "",
          inWorkspace: false,
          exists: false,
          bytes: 0,
          kind: "missing",
          reason: verdict.reason,
        };
      }
      if (verdict.outcome === "missing") {
        return {
          query: request.query,
          ...echo,
          ...kinds,
          path: verdict.path,
          relativePath: verdict.relativePath,
          inWorkspace: !isAbsolute(verdict.relativePath),
          exists: false,
          bytes: 0,
          kind: "missing",
          reason: "nothing exists at this path",
        };
      }

      // An allowed absolute path outside the root is attachable but must not
      // claim to be in the workspace: its verdict carries the absolute path
      // as its own display path, which is the tell.
      const within = !isAbsolute(verdict.relativePath);

      let info: Awaited<ReturnType<typeof stat>>;
      try {
        info = await stat(verdict.realPath);
      } catch {
        return {
          query: request.query,
          ...echo,
          ...kinds,
          path: verdict.path,
          relativePath: verdict.relativePath,
          inWorkspace: within,
          exists: false,
          bytes: 0,
          kind: "missing",
          reason: "nothing exists at this path",
        };
      }

      if (info.isDirectory()) {
        return {
          query: request.query,
          ...echo,
          ...kinds,
          path: verdict.path,
          relativePath: verdict.relativePath,
          inWorkspace: within,
          exists: true,
          bytes: 0,
          kind: "directory",
          reason: "a directory cannot be attached; name a file inside it",
        };
      }
      if (!info.isFile()) {
        return {
          query: request.query,
          ...echo,
          ...kinds,
          path: verdict.path,
          relativePath: verdict.relativePath,
          inWorkspace: within,
          exists: true,
          bytes: 0,
          kind: "other",
          reason: "not a regular file",
        };
      }

      const kind: ContextKind =
        IMAGE_MIME_TYPES[extname(verdict.realPath).toLowerCase()] === undefined ? "file" : "image";
      return {
        query: request.query,
        ...echo,
        ...kinds,
        path: verdict.path,
        relativePath: verdict.relativePath,
        inWorkspace: within,
        exists: true,
        bytes: info.size,
        kind,
      };
    },
  };
}
