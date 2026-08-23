/** The `fetch` built-in tool: HTTP GET a URL and return readable text. */

import type { Tool, ToolResult } from "@arcturn/types";
import { abortedResult, errorResult } from "./result-utils.js";

/** Default response body truncation, in bytes. */
export const DEFAULT_MAX_BYTES = 100 * 1024;
const TIMEOUT_MS = 30_000;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  copy: "©",
  reg: "®",
  trade: "™",
  rsquo: "’",
  lsquo: "‘",
  rdquo: "”",
  ldquo: "“",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const isHex = entity[1] === "x" || entity[1] === "X";
      const codePoint = isHex
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      if (Number.isNaN(codePoint)) return match;
      try {
        return String.fromCodePoint(codePoint);
      } catch {
        return match;
      }
    }
    return NAMED_ENTITIES[entity] ?? match;
  });
}

/** Strip HTML tags/scripts/styles/comments down to readable plain text. */
export function stripHtml(html: string): string {
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6]|section|article|header|footer)>/gi, "\n")
    .replace(/<[^>]+>/g, " ");
  text = decodeEntities(text);
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface FetchToolDetails {
  url: string;
  status: number;
  contentType: string;
  truncated: boolean;
}

/** Create the `fetch` tool. Always requests permission (subject: the URL's origin). */
export function createFetchTool(): Tool {
  return {
    definition: {
      name: "fetch",
      description:
        "Fetch a URL via HTTP GET and return its content as readable text. HTML responses have tags " +
        `stripped. Redirects are followed. Response body is truncated to roughly ${
          DEFAULT_MAX_BYTES / 1024
        }KB by default.`,
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The URL to fetch. Must include a scheme, e.g. https://example.com.",
          },
          maxBytes: {
            type: "number",
            description: `Maximum bytes of the response body to read. Defaults to ${DEFAULT_MAX_BYTES}.`,
          },
        },
        required: ["url"],
        additionalProperties: false,
      },
    },
    async execute(input, ctx): Promise<ToolResult> {
      if (ctx.signal.aborted) return abortedResult();

      const rawUrl = input.url;
      if (typeof rawUrl !== "string" || rawUrl.length === 0) {
        return errorResult("`url` is required and must be a non-empty string.");
      }
      let parsed: URL;
      try {
        parsed = new URL(rawUrl);
      } catch {
        return errorResult(`Invalid URL: ${rawUrl}`);
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return errorResult(
          `Unsupported URL scheme: ${parsed.protocol}. Only http and https are allowed.`,
        );
      }
      const maxBytes =
        typeof input.maxBytes === "number" && input.maxBytes > 0
          ? Math.floor(input.maxBytes)
          : DEFAULT_MAX_BYTES;

      const decision = await ctx.requestPermission({
        toolName: "fetch",
        toolCallId: ctx.toolCallId,
        subject: parsed.origin,
        description: `Fetch ${parsed.toString()}`,
        suggestedRule: { tool: "fetch", specifier: parsed.origin, action: "allow" },
      });
      if (decision.behavior !== "allow") {
        return errorResult(decision.message ?? `Permission denied to fetch ${parsed.origin}.`);
      }
      if (ctx.signal.aborted) return abortedResult();

      const timeoutController = new AbortController();
      const timeoutId = setTimeout(() => timeoutController.abort(), TIMEOUT_MS);
      const combinedSignal = AbortSignal.any([ctx.signal, timeoutController.signal]);

      try {
        const response = await fetch(parsed, { signal: combinedSignal, redirect: "follow" });
        const contentType = response.headers.get("content-type") ?? "";
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const truncated = buffer.length > maxBytes;
        const kept = truncated ? buffer.subarray(0, maxBytes) : buffer;
        let text = kept.toString("utf8");
        if (contentType.includes("text/html")) {
          text = stripHtml(text);
        }
        if (truncated) {
          text += `\n\n[Truncated: response is ${buffer.length} bytes, showing first ${maxBytes}.]`;
        }

        const details: FetchToolDetails = {
          url: parsed.toString(),
          status: response.status,
          contentType,
          truncated,
        };
        return {
          content: [{ type: "text", text: text || "(empty response)" }],
          isError: !response.ok,
          details: details as unknown as Record<string, unknown>,
        };
      } catch (error) {
        if (ctx.signal.aborted || timeoutController.signal.aborted) {
          return errorResult(`Fetch of ${parsed.toString()} timed out or was aborted.`);
        }
        return errorResult(`Fetch failed: ${(error as Error).message}`);
      } finally {
        clearTimeout(timeoutId);
      }
    },
  };
}
