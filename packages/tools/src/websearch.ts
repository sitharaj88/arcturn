/** The `websearch` built-in tool: search the web and return readable results. */

import type { Tool, ToolResult } from "@arcturn/types";
import { abortedResult, errorResult, textResult } from "./result-utils.js";

/** Default number of results requested/returned. */
export const DEFAULT_MAX_RESULTS = 5;
/** Hard ceiling on the number of results requested/returned. */
export const MAX_MAX_RESULTS = 10;
const TIMEOUT_MS = 15_000;

const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";
const DDG_ENDPOINT = "https://html.duckduckgo.com/html/";

/** One search result, provider-agnostic. */
export interface WebSearchResultItem {
  title: string;
  url: string;
  description: string;
}

export interface WebSearchToolDetails {
  provider: "brave" | "duckduckgo";
  resultCount: number;
}

/** Collapse HTML whitespace/entities down to plain, single-line text. */
function decodeAndClean(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Parse DuckDuckGo's HTML lite results page with regexes (no HTML-parser
 * dependency). Each result is a `result__a` anchor followed, somewhere
 * before the next anchor, by a `result__snippet` span.
 */
export function parseDuckDuckGoHtml(html: string): WebSearchResultItem[] {
  const results: WebSearchResultItem[] = [];
  const anchorRe =
    /<a[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g;
  const snippetRe = /<a[^>]*class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/a>/g;

  const anchors: Array<{ index: number; url: string; title: string }> = [];
  for (const match of html.matchAll(anchorRe)) {
    const rawUrl = match[1] ?? "";
    const url = decodeDuckDuckGoRedirect(rawUrl);
    const title = decodeAndClean(match[2] ?? "");
    if (url && title) {
      anchors.push({ index: match.index ?? 0, url, title });
    }
  }

  const snippets: Array<{ index: number; text: string }> = [];
  for (const match of html.matchAll(snippetRe)) {
    snippets.push({ index: match.index ?? 0, text: decodeAndClean(match[1] ?? "") });
  }

  for (let i = 0; i < anchors.length; i++) {
    const anchor = anchors[i];
    if (!anchor) continue;
    const nextIndex = anchors[i + 1]?.index ?? Number.POSITIVE_INFINITY;
    const snippet = snippets.find((s) => s.index > anchor.index && s.index < nextIndex);
    results.push({ title: anchor.title, url: anchor.url, description: snippet?.text ?? "" });
  }

  return results;
}

/** DuckDuckGo's HTML endpoint links via `//duckduckgo.com/l/?uddg=<encoded>&...`. */
function decodeDuckDuckGoRedirect(href: string): string {
  if (href.startsWith("//duckduckgo.com/l/") || href.includes("duckduckgo.com/l/")) {
    try {
      const asUrl = new URL(href.startsWith("//") ? `https:${href}` : href);
      const target = asUrl.searchParams.get("uddg");
      if (target) return decodeURIComponent(target);
    } catch {
      // fall through to the raw href
    }
  }
  return href;
}

interface BraveSearchResult {
  title?: string;
  url?: string;
  description?: string;
}

interface BraveSearchResponse {
  web?: {
    results?: BraveSearchResult[];
  };
}

/** Parse a Brave Search API JSON body into provider-agnostic results. */
export function parseBraveResponse(body: unknown): WebSearchResultItem[] {
  if (typeof body !== "object" || body === null) return [];
  const results = (body as BraveSearchResponse).web?.results;
  if (!Array.isArray(results)) return [];
  const items: WebSearchResultItem[] = [];
  for (const entry of results) {
    if (!entry || typeof entry !== "object") continue;
    const title = typeof entry.title === "string" ? entry.title : "";
    const url = typeof entry.url === "string" ? entry.url : "";
    const description = typeof entry.description === "string" ? entry.description : "";
    if (title && url) items.push({ title, url, description: decodeAndClean(description) });
  }
  return items;
}

/** Format results as numbered "title — url" lines with indented snippets. */
export function formatResults(results: WebSearchResultItem[]): string {
  return results
    .map((result, i) => {
      const header = `${i + 1}. ${result.title} — ${result.url}`;
      if (!result.description) return header;
      return `${header}\n    ${result.description}`;
    })
    .join("\n\n");
}

function clampMaxResults(input: unknown): number {
  if (typeof input === "number" && Number.isFinite(input) && input > 0) {
    return Math.min(Math.floor(input), MAX_MAX_RESULTS);
  }
  return DEFAULT_MAX_RESULTS;
}

/** Create the `websearch` tool. Read-only: never requests permission. */
export function createWebSearchTool(): Tool {
  return {
    definition: {
      name: "websearch",
      description:
        "Search the web and return a numbered list of results (title, URL, and snippet). Uses " +
        "the Brave Search API when BRAVE_API_KEY is set, otherwise falls back to DuckDuckGo.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search query.",
          },
          maxResults: {
            type: "number",
            description: `Maximum number of results to return (default ${DEFAULT_MAX_RESULTS}, max ${MAX_MAX_RESULTS}).`,
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    async execute(input, ctx): Promise<ToolResult> {
      if (ctx.signal.aborted) return abortedResult();

      const query = input.query;
      if (typeof query !== "string" || query.trim().length === 0) {
        return errorResult("`query` is required and must be a non-empty string.");
      }
      const maxResults = clampMaxResults(input.maxResults);

      const timeoutController = new AbortController();
      const timeoutId = setTimeout(() => timeoutController.abort(), TIMEOUT_MS);
      const signal = AbortSignal.any([ctx.signal, timeoutController.signal]);

      try {
        const apiKey = process.env.BRAVE_API_KEY;
        if (apiKey) {
          return await runBraveSearch(query, maxResults, apiKey, signal, ctx.signal);
        }
        return await runDuckDuckGoSearch(query, maxResults, signal, ctx.signal);
      } finally {
        clearTimeout(timeoutId);
      }
    },
  };
}

function isAbortError(error: unknown, ctxSignal: AbortSignal): boolean {
  return ctxSignal.aborted || (error instanceof Error && error.name === "AbortError");
}

async function runBraveSearch(
  query: string,
  maxResults: number,
  apiKey: string,
  signal: AbortSignal,
  ctxSignal: AbortSignal,
): Promise<ToolResult> {
  const url = new URL(BRAVE_ENDPOINT);
  url.searchParams.set("q", query);
  url.searchParams.set("count", String(maxResults));

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "X-Subscription-Token": apiKey,
      },
      signal,
    });
    if (!response.ok) {
      return errorResult(`Brave search failed with HTTP status ${response.status}.`);
    }
    const body = await response.json();
    const results = parseBraveResponse(body).slice(0, maxResults);
    if (results.length === 0) {
      return errorResult(`No results found for "${query}".`);
    }
    const details: WebSearchToolDetails = { provider: "brave", resultCount: results.length };
    return textResult(formatResults(results), details as unknown as Record<string, unknown>);
  } catch (error) {
    if (isAbortError(error, ctxSignal)) {
      return errorResult(`Web search for "${query}" timed out or was aborted.`);
    }
    return errorResult(`Brave search failed: ${(error as Error).message}`);
  }
}

async function runDuckDuckGoSearch(
  query: string,
  maxResults: number,
  signal: AbortSignal,
  ctxSignal: AbortSignal,
): Promise<ToolResult> {
  try {
    const response = await fetch(DDG_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: `q=${encodeURIComponent(query)}`,
      signal,
    });
    if (!response.ok) {
      return errorResult(`DuckDuckGo search failed with HTTP status ${response.status}.`);
    }
    const html = await response.text();
    const results = parseDuckDuckGoHtml(html).slice(0, maxResults);
    if (results.length === 0) {
      return errorResult(`No results found for "${query}".`);
    }
    const details: WebSearchToolDetails = { provider: "duckduckgo", resultCount: results.length };
    return textResult(formatResults(results), details as unknown as Record<string, unknown>);
  } catch (error) {
    if (isAbortError(error, ctxSignal)) {
      return errorResult(`Web search for "${query}" timed out or was aborted.`);
    }
    return errorResult(`DuckDuckGo search failed: ${(error as Error).message}`);
  }
}
