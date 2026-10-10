/**
 * PROVIDER-RUN TOOLS — the CLI half of `LLMRequest.serverTools`.
 *
 * The adapter decides what a model and platform actually take (Anthropic's
 * `anthropicWebTools`), and leaves out of the wire the client tool a native one
 * replaces. This module decides what a session *asks* for:
 *
 * - `websearch` / `webfetch` set to `{"provider": "anthropic"}` ask for the
 *   server's web search / fetch, with a domain filter read off the host-shaped
 *   permission rules ({@link nativeWebServerTools});
 * - each request asks only for the native tools whose client tool it offers
 *   (`replaces`), so plan mode, a role's tool allowlist or a read-only scout
 *   that has no `fetch` never gains the server's fetch ({@link serverToolPlanner});
 * - {@link withServerTools} puts the answer on every request. It wraps the
 *   provider client *inside* failover, so each link asks for its own model.
 *
 * It also renders the server's own blocks for the transcript and the export
 * ({@link describeServerTools}): a web search or fetch reads as a tool row
 * with its query or URL and a result summary.
 */

import { anthropicAdvisorPairValid, anthropicServerToolFamily, getModel } from "@arcturn/ai";
import type {
  AssistantContent,
  LLMClient,
  LLMRequest,
  Message,
  ModelSpec,
  PermissionRule,
  ServerToolRequest,
  Usage,
} from "@arcturn/types";
import type { NativeWebToolConfig } from "./config.js";
import { formatCost, formatTokens } from "./format.js";

/**
 * The plain hostname a permission specifier names, or `undefined` when it is
 * not host-shaped.
 *
 * Accepted: an origin (`https://docs.example.com`, port dropped), a bare host
 * (`docs.example.com`) and a subdomain wildcard (`*.example.com`, read as
 * `example.com` — the API's lists cover subdomains, so this also covers the
 * apex). Refused: anything with a path or another wildcard, IP addresses,
 * single-label and `localhost`-style names — the forms the API's domain lists
 * reject.
 */
export function hostOfSpecifier(specifier: string | undefined): string | undefined {
  if (specifier === undefined) return undefined;
  let value = specifier.trim().toLowerCase();
  const scheme = /^[a-z][a-z0-9+.-]*:\/\//.exec(value);
  if (scheme) value = value.slice(scheme[0].length);
  if (value.endsWith("/")) value = value.slice(0, -1);
  if (value.includes("/")) return undefined;
  value = value.replace(/:\d+$/, "");
  if (value.startsWith("*.")) value = value.slice(2);
  if (value === "" || /[*?\s@]/.test(value)) return undefined;
  const labels = value.split(".");
  if (labels.length < 2) return undefined;
  const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
  if (!labels.every((part) => label.test(part))) return undefined;
  const tld = labels[labels.length - 1] ?? "";
  if (!/^(?:[a-z]{2,}|xn--[a-z0-9-]+)$/.test(tld)) return undefined;
  if (tld === "localhost" || tld === "local") return undefined;
  return value;
}

/** Most hostnames the API takes in one `allowed_domains` / `blocked_domains` list. */
const MAX_DOMAINS_PER_LIST = 64;

/** The native web tools a session asks for, and what to tell the user about them. */
export interface NativeWebPlan {
  tools: ServerToolRequest[];
  /** One-time notices (a dropped allow list), for the startup warnings. */
  notices: string[];
}

/**
 * The `webSearch` / `webFetch` entries `websearch` / `webfetch` ask for.
 *
 * Domains come from host-shaped permission rules ({@link hostOfSpecifier}):
 * - `allowed_domains` — `allow` rules on the tool's own client tool
 *   (`websearch` for search, `fetch` for fetch);
 * - `blocked_domains` — `deny` rules on either `fetch` or `websearch`: a host
 *   the user refused to reach is refused to both.
 *
 * The API rejects a tool carrying both lists, so when both kinds apply the
 * deny list is sent and a notice says the allow list is not enforced there.
 */
export function nativeWebServerTools(
  config: { websearch?: NativeWebToolConfig; webfetch?: NativeWebToolConfig },
  rules: readonly PermissionRule[],
): NativeWebPlan {
  const hosts = (tools: readonly string[], action: PermissionRule["action"]): string[] => {
    const out: string[] = [];
    for (const rule of rules) {
      if (rule.action !== action || !tools.includes(rule.tool)) continue;
      const host = hostOfSpecifier(rule.specifier);
      if (host !== undefined && !out.includes(host)) out.push(host);
    }
    return out;
  };
  const blocked = hosts(["fetch", "websearch"], "deny");
  const tools: ServerToolRequest[] = [];
  const notices: string[] = [];
  // A deny rule the API's lists cannot say (a path, an IP, a pattern) is not
  // enforced on the provider's tool: the user hears of it rather than finding
  // out from a fetch.
  for (const rule of rules) {
    if (rule.action !== "deny" || !(rule.tool === "fetch" || rule.tool === "websearch")) continue;
    if (rule.specifier === undefined || rule.specifier.trim() === "") continue;
    if (hostOfSpecifier(rule.specifier) !== undefined) continue;
    notices.push(
      `Your deny rule ${rule.tool}(${rule.specifier}) is not a plain host, so the provider's ` +
        "native web tools cannot honour it.",
    );
  }
  const add = (
    kind: "webSearch" | "webFetch",
    client: "websearch" | "fetch",
    wire: string,
    settings: NativeWebToolConfig | undefined,
  ): void => {
    if (settings?.provider !== "anthropic") return;
    // A tool the user denied outright stays denied: the native one would
    // otherwise reach the web without ever consulting the rule.
    if (
      rules.some(
        (rule) => rule.action === "deny" && rule.tool === client && !rule.specifier?.trim(),
      )
    ) {
      notices.push(
        `${client} is denied by a permission rule, so the native ${wire} is not offered either.`,
      );
      return;
    }
    // The API takes 1-64 hostnames per list and 400s the whole request beyond
    // that. A longer allow list is cut (narrower, never wider); a longer deny
    // list cannot be cut without letting a refused host through, so the
    // native tool is not offered.
    if (blocked.length > MAX_DOMAINS_PER_LIST) {
      notices.push(
        `Your deny rules name more than ${MAX_DOMAINS_PER_LIST} hosts, which the provider's ` +
          `${wire} cannot take; the client ${client} tool is used instead.`,
      );
      return;
    }
    const allowedAll = hosts([client], "allow");
    if (allowedAll.length > MAX_DOMAINS_PER_LIST) {
      notices.push(
        `Native ${wire} takes at most ${MAX_DOMAINS_PER_LIST} allowed hosts; only the first ` +
          `${MAX_DOMAINS_PER_LIST} of your ${client} allow rules are sent.`,
      );
    }
    const allowed = allowedAll.slice(0, MAX_DOMAINS_PER_LIST);
    const domains =
      blocked.length > 0
        ? { blockedDomains: blocked }
        : allowed.length > 0
          ? { allowedDomains: allowed }
          : {};
    tools.push({
      kind,
      replaces: client,
      ...(settings.maxUses === undefined ? {} : { maxUses: settings.maxUses }),
      ...domains,
    });
    if (blocked.length > 0 && allowed.length > 0) {
      notices.push(
        `Native ${wire} takes a single domain list and your ${client} rules give it both: only ` +
          `the deny list (${blocked.join(", ")}) is sent, so the allow rules ` +
          `(${allowed.join(", ")}) do not limit where it reaches.`,
      );
    }
  };
  add("webSearch", "websearch", "web_search", config.websearch);
  add("webFetch", "fetch", "web_fetch", config.webfetch);
  return { tools, notices };
}

/** Decides the server tools one request asks for. */
export type ServerToolPlanner = (request: LLMRequest) => readonly ServerToolRequest[];

/** A resolved `route.advisor` pairing. */
export interface AdvisorPairing {
  executor: ModelSpec;
  advisor: ModelSpec;
}

/** What {@link serverToolPlanner} plans from. */
export interface ServerToolPlannerOptions {
  /** The session's native web tools, from {@link nativeWebServerTools}. */
  web?: readonly ServerToolRequest[];
  /** The `route.advisor` pairing, resolved. */
  advisor?: AdvisorPairing;
}

/** Whether any assistant turn in `messages` carries an advisor block. */
function usedAdvisor(messages: readonly Message[]): boolean {
  return messages.some(
    (message) =>
      message.role === "assistant" &&
      message.content.some(
        (part) =>
          part.type === "serverTool" &&
          part.provider === "anthropic" &&
          anthropicServerToolFamily(part.block) === "advisor",
      ),
  );
}

/**
 * A planner over the session's settings.
 *
 * A web entry goes on a request only when that request offers the client
 * tool it `replaces`: the native tool stands in for a tool the caller granted,
 * never adds one it withheld.
 *
 * The advisor goes on a request whose model is the executor — and, once the
 * history carries advisor blocks, on any request whose model the advisor may
 * still advise (a `/model` switch, a sub-agent): taking the tool away while
 * its blocks remain is a 400, and keeping it is what keeps those blocks — and
 * the thinking after them — on the wire. Where the pair is invalid (or the
 * platform has no advisor) nothing is asked for and the adapter drops the
 * advisor blocks, call and result together, which is the one consistent way
 * left to send that history.
 */
export function serverToolPlanner(options: ServerToolPlannerOptions): ServerToolPlanner {
  return (request) => {
    const offered = new Set((request.tools ?? []).map((tool) => tool.name));
    const out: ServerToolRequest[] = [];
    for (const entry of options.web ?? []) {
      if (entry.kind === "advisor") continue;
      if (entry.replaces !== undefined && !offered.has(entry.replaces)) continue;
      out.push(entry);
    }
    const pairing = options.advisor;
    if (pairing !== undefined) {
      const isExecutor = request.model.id === pairing.executor.id;
      const keep =
        !isExecutor &&
        anthropicAdvisorPairValid(request.model.model, pairing.advisor.model) &&
        usedAdvisor(request.messages);
      if (isExecutor || keep) out.push({ kind: "advisor", model: pairing.advisor.model });
    }
    return out;
  };
}

/**
 * The `/cost` lines for the advisors a session's usage carries: model, token
 * counts, cost and its share of the session total.
 *
 * @param usage - The session's summed usage.
 * @param totalCostUsd - The session's total cost (advisor included).
 */
export function advisorCostLines(usage: Usage, totalCostUsd: number): string[] {
  const lines: string[] = [];
  for (const entry of usage.advisor ?? []) {
    const name = getModel(entry.model)?.displayName ?? entry.model;
    const tokens = [
      `${formatTokens(entry.inputTokens)} in`,
      `${formatTokens(entry.outputTokens)} out`,
      ...(entry.cacheReadTokens > 0 ? [`${formatTokens(entry.cacheReadTokens)} cache read`] : []),
      ...(entry.cacheWriteTokens > 0
        ? [`${formatTokens(entry.cacheWriteTokens)} cache write`]
        : []),
    ].join(" · ");
    const cost =
      entry.costUsd === undefined
        ? "cost n/a"
        : totalCostUsd > 0
          ? `${formatCost(entry.costUsd)} (${Math.round((entry.costUsd / totalCostUsd) * 100)}% of cost)`
          : formatCost(entry.costUsd);
    lines.push(`  advisor    ${name} · ${tokens} · ${cost}`);
  }
  return lines;
}

/**
 * Wrap a client so every request carries what `planner` asks for, appended
 * to any `serverTools` the request already has. A request that asks for
 * nothing goes through untouched.
 */
export function withServerTools(client: LLMClient, planner: ServerToolPlanner): LLMClient {
  const decorate = (request: LLMRequest): LLMRequest => {
    const planned = planner(request);
    if (planned.length === 0) return request;
    return { ...request, serverTools: [...(request.serverTools ?? []), ...planned] };
  };
  return {
    stream: (request) => client.stream(decorate(request)),
    complete: (request) => client.complete(decorate(request)),
  };
}

/**
 * One server-run tool call, as the transcript shows it: the call and, when it
 * came back, its result — a list of result lines or the error code.
 */
export interface ServerToolRow {
  /** The server tool's name: `web_search`, `web_fetch`, `advisor`. */
  name: string;
  /** The query, the URL, or `""`. */
  subject: string;
  /** One line per result (`title — url`), when the call succeeded. */
  results?: string[];
  /** The provider's error code, when it failed. */
  error?: string;
}

/** The server tools rendered as rows; the rest (tool search, code execution) stay quiet. */
const SHOWN = new Set(["web_search", "web_fetch", "advisor"]);

const RESULT_NAMES: Readonly<Record<string, string>> = {
  web_search_tool_result: "web_search",
  web_fetch_tool_result: "web_fetch",
  advisor_tool_result: "advisor",
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** A result block's content as rows: `results` on success, `error` on failure. */
function resultOf(name: string, content: unknown): Pick<ServerToolRow, "results" | "error"> {
  // A server tool's error is an object where its success is a list (search)
  // or a typed result object (fetch, advisor): branch on the shape first.
  if (Array.isArray(content)) {
    const results: string[] = [];
    for (const item of content) {
      const entry = asRecord(item);
      const url = str(entry?.url);
      if (url === undefined) continue;
      const title = str(entry?.title);
      results.push(title === undefined ? url : `${title} — ${url}`);
    }
    return { results };
  }
  const record = asRecord(content);
  if (record === undefined) return {};
  const code = str(record.error_code);
  if (code !== undefined) return { error: code };
  if (name === "web_fetch") {
    const url = str(record.url);
    const title = str(asRecord(record.content)?.title);
    if (url === undefined) return {};
    return { results: [title === undefined ? url : `${title} — ${url}`] };
  }
  if (name === "advisor") {
    if (record.type === "advisor_redacted_result") return { results: ["advice (encrypted)"] };
    const text = str(record.text);
    return text === undefined ? {} : { results: [text.split("\n")[0] ?? text] };
  }
  return {};
}

/**
 * Whether {@link describeServerTools} accounts for a server block — draws it
 * as part of a row, or deliberately hides it (the code the dynamic web tools
 * run on themselves). Anything else (tool search) keeps its generic label.
 */
export function isDescribedServerBlock(block: Readonly<Record<string, unknown>>): boolean {
  const caller = asRecord(block.caller);
  if (caller !== undefined && caller.type !== "direct") return true;
  if (block.type === "server_tool_use")
    return typeof block.name === "string" && SHOWN.has(block.name);
  return typeof block.type === "string" && RESULT_NAMES[block.type] !== undefined;
}

/** A row as one line of plain text: `web_search "query" — 2 results` style. */
export function serverToolRowText(row: ServerToolRow): string {
  const subject = row.subject === "" ? "" : ` ${JSON.stringify(row.subject)}`;
  if (row.error !== undefined) return `${row.name}${subject} — failed: ${row.error}`;
  if (row.results === undefined) return `${row.name}${subject}`;
  const count = row.results.length;
  return `${row.name}${subject} — ${count} ${count === 1 ? "result" : "results"}`;
}

/**
 * Pair each server-run call in an assistant message with its result, in the
 * order the calls were made. Only provider-run web search, web fetch and the
 * advisor are shown; the code the dynamic web tools run on themselves and the
 * tool-search plumbing are left out.
 */
export function describeServerTools(content: readonly AssistantContent[]): ServerToolRow[] {
  const rows: ServerToolRow[] = [];
  const byId = new Map<string, ServerToolRow>();
  for (const part of content) {
    if (part.type !== "serverTool") continue;
    const block = part.block;
    const caller = asRecord(block.caller);
    if (caller !== undefined && caller.type !== "direct") continue;
    if (block.type === "server_tool_use") {
      const name = str(block.name);
      if (name === undefined || !SHOWN.has(name)) continue;
      const input = asRecord(block.input);
      const row: ServerToolRow = {
        name,
        subject: str(input?.query) ?? str(input?.url) ?? "",
      };
      rows.push(row);
      const id = str(block.id);
      if (id !== undefined) byId.set(id, row);
      continue;
    }
    const name = typeof block.type === "string" ? RESULT_NAMES[block.type] : undefined;
    if (name === undefined) continue;
    const id = str(block.tool_use_id);
    let row = id === undefined ? undefined : byId.get(id);
    if (row === undefined) {
      row = { name, subject: "" };
      rows.push(row);
    }
    Object.assign(row, resultOf(name, block.content));
  }
  return rows;
}
