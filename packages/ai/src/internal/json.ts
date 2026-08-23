/**
 * Never-throwing JSON helpers for streamed tool-call arguments.
 *
 * Providers stream tool arguments as raw JSON fragments. A stream can be cut
 * short, and some OpenAI-compatible gateways emit raw control characters inside
 * strings, so a plain `JSON.parse` is not enough. This module implements a
 * small ladder: parse, repair-and-parse, complete-and-parse, give up.
 */

/** Escape raw control characters and dangling backslashes inside JSON strings. */
function repairJson(input: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const char of input) {
    if (escaped) {
      // A backslash may only be followed by a valid escape character.
      if (inString && !'"\\/bfnrtu'.includes(char)) {
        out += `\\${char}`;
      } else {
        out += char;
      }
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      out += char;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      out += char;
      continue;
    }
    if (inString && char < " ") {
      const code = char.charCodeAt(0);
      const short: Record<number, string> = { 8: "\\b", 9: "\\t", 10: "\\n", 12: "\\f", 13: "\\r" };
      out += short[code] ?? `\\u${code.toString(16).padStart(4, "0")}`;
      continue;
    }
    out += char;
  }
  if (escaped) out = out.slice(0, -1);
  return out;
}

/**
 * Close any structures left open by a truncated stream so the prefix becomes
 * parseable. Trailing commas and half-written keys are trimmed away.
 */
function completeJson(input: string): string | undefined {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (const char of input) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{" || char === "[") stack.push(char);
    else if (char === "}" || char === "]") stack.pop();
  }

  if (stack.length === 0 && !inString) return undefined;

  // Drop the unterminated trailing string, then any dangling separator, then a
  // key that has no value yet (`{"a":1,"b":` -> `{"a":1`).
  let head = inString ? input.slice(0, input.lastIndexOf('"')) : input;
  head = head.replace(/[,\s]+$/, "");
  head = head.replace(/(?:,|\{)\s*"(?:[^"\\]|\\.)*"\s*:\s*$/, (m) =>
    m.startsWith("{") ? "{" : "",
  );
  head = head.replace(/[,\s]+$/, "");

  let closed = head;
  for (let i = stack.length - 1; i >= 0; i--) {
    closed += stack[i] === "{" ? "}" : "]";
  }
  return closed;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function tryParse(text: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/**
 * Best-effort parse of accumulated tool-call arguments.
 *
 * Always returns an object; malformed or truncated input degrades to the
 * largest parseable prefix, and finally to `{}`.
 */
export function parseToolArguments(raw: string): Record<string, unknown> {
  const text = raw.trim();
  if (text === "") return {};

  const direct = tryParse(text);
  if (direct) return direct;

  const repaired = repairJson(text);
  const fromRepaired = tryParse(repaired);
  if (fromRepaired) return fromRepaired;

  const completed = completeJson(repaired);
  if (completed !== undefined) {
    const fromCompleted = tryParse(completed);
    if (fromCompleted) return fromCompleted;
  }

  return {};
}

/** True when `raw` is valid JSON describing an object. */
export function isCompleteJsonObject(raw: string): boolean {
  return tryParse(raw.trim()) !== undefined;
}
