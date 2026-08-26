/** The `fetch` built-in tool: HTTP GET a URL and return readable text. */

import type { Tool, ToolResult } from "@arcturn/types";
import { abortedResult, errorResult } from "./result-utils.js";

/** Default response body truncation, in bytes. */
export const DEFAULT_MAX_BYTES = 100 * 1024;
const TIMEOUT_MS = 30_000;
/** How many redirects a single `fetch` call will follow before giving up. */
export const MAX_REDIRECTS = 5;

/** HTTP statuses whose `Location` header names where to go next. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

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
  /** The URL the response actually came from, after any redirects. */
  url: string;
  /** The URL the caller asked for; present only when a redirect moved it. */
  requestedUrl?: string;
  status: number;
  contentType: string;
  truncated: boolean;
}

/**
 * Read at most `maxBytes` of `body`, then stop pulling.
 *
 * The point is the *stop*: `response.arrayBuffer()` buffers the entire body
 * before anything can be sliced off it, so `maxBytes: 1024` against a 5GB
 * download read 5GB into memory and threw away all but a kilobyte of it.
 * Cancelling the reader closes the connection, so the server stops sending.
 *
 * Reads one chunk *past* the limit on purpose: that is what makes `truncated`
 * exact rather than a guess, and it costs one chunk (tens of KB), not the
 * rest of the response.
 */
async function readBounded(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ buffer: Buffer; truncated: boolean }> {
  if (body === null) return { buffer: Buffer.alloc(0), truncated: false };
  const chunks: Buffer[] = [];
  let received = 0;
  let truncated = false;
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      chunks.push(chunk);
      received += chunk.length;
      if (received > maxBytes) {
        truncated = true;
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {
      // The body is being abandoned; a cancel that fails changes nothing.
    });
  }
  return { buffer: Buffer.concat(chunks), truncated };
}

/** Create the `fetch` tool. Always requests permission (subject: the URL's origin). */
export function createFetchTool(): Tool {
  return {
    definition: {
      name: "fetch",
      description:
        "Fetch a URL via HTTP GET and return its content as readable text. HTML responses have tags " +
        `stripped. Up to ${MAX_REDIRECTS} redirects are followed; a redirect to a different origin ` +
        "asks for permission again, and the URL the content actually came from is reported back. " +
        `Response body is truncated to roughly ${DEFAULT_MAX_BYTES / 1024}KB by default.`,
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
        // Redirects are followed by hand rather than by `redirect: "follow"`.
        // Permission for this tool is granted per *origin*, and the origin the
        // user approved is not necessarily the origin a redirect lands on: a
        // page on an allowlisted host can bounce the fetch to a link-local
        // metadata service or an internal admin port, and with automatic
        // following nobody — not the permission engine, not the user, not even
        // the returned `details` — ever names the host that answered.
        let target = parsed;
        let approvedOrigin = parsed.origin;
        let response: Response | undefined;
        for (let hop = 0; ; hop++) {
          response = await fetch(target, { signal: combinedSignal, redirect: "manual" });
          const location = response.headers.get("location");
          if (!REDIRECT_STATUSES.has(response.status) || location === null) break;
          // Whatever happens next, this hop's body is not the answer.
          await response.body?.cancel().catch(() => {});
          if (hop >= MAX_REDIRECTS) {
            return errorResult(
              `Too many redirects: ${parsed.toString()} redirected more than ${MAX_REDIRECTS} times.`,
            );
          }
          let next: URL;
          try {
            next = new URL(location, target);
          } catch {
            return errorResult(
              `Cannot follow the redirect from ${target.toString()}: invalid Location "${location}".`,
            );
          }
          if (next.protocol !== "http:" && next.protocol !== "https:") {
            return errorResult(
              `Refusing to follow a redirect from ${target.toString()} to ${next.protocol} — ` +
                "only http and https are allowed.",
            );
          }
          if (next.origin !== approvedOrigin) {
            const hopDecision = await ctx.requestPermission({
              toolName: "fetch",
              toolCallId: ctx.toolCallId,
              subject: next.origin,
              description: `Follow redirect from ${target.origin} to ${next.toString()}`,
              suggestedRule: { tool: "fetch", specifier: next.origin, action: "allow" },
            });
            if (hopDecision.behavior !== "allow") {
              return errorResult(
                hopDecision.message ??
                  `Permission denied to follow a redirect to ${next.origin} (approved origin was ${approvedOrigin}).`,
              );
            }
            approvedOrigin = next.origin;
          }
          if (ctx.signal.aborted) return abortedResult();
          target = next;
        }

        const contentType = response.headers.get("content-type") ?? "";
        const { buffer, truncated } = await readBounded(response.body, maxBytes);
        const kept = truncated ? buffer.subarray(0, maxBytes) : buffer;
        let text = kept.toString("utf8");
        if (contentType.includes("text/html")) {
          text = stripHtml(text);
        }
        if (truncated) {
          const declared = Number(response.headers.get("content-length"));
          const size = Number.isFinite(declared) && declared > 0 ? `${declared} bytes` : "larger";
          text += `\n\n[Truncated: response is ${size}, showing first ${maxBytes} bytes.]`;
        }

        const finalUrl = target.toString();
        const details: FetchToolDetails = {
          url: finalUrl,
          ...(finalUrl === parsed.toString() ? {} : { requestedUrl: parsed.toString() }),
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
