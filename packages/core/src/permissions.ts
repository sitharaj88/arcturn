/**
 * Rule-based permission engine.
 *
 * Resolution order for a tool call:
 * 1. Tools listed in {@link PermissionEngineOptions.alwaysAllowTools} pass silently.
 * 2. `plan` mode denies anything outside the read-only allow list.
 * 3. Stored rules are matched (session > project > user, then specificity).
 * 4. Read-only tools are allowed.
 * 5. `yolo` allows, `acceptEdits` allows edit tools.
 * 6. Anything left over is asked via the injected {@link PermissionPrompt};
 *    with no requester configured the check is denied rather than assumed safe.
 *
 * A `permissionRequest` event is emitted only at step 6, when the user is
 * genuinely being asked. Every check, however it resolves, emits exactly one
 * `permissionDecision` — step 1 included, since that list is overridable and
 * an allow nobody can review afterwards is not one. A `deny` also outranks a
 * permissive rule from a nearer scope unless that rule is STRICTLY more
 * specific, so a checked-in project config cannot cancel a user's own deny by
 * restating it — see {@link matchRules}.
 *
 * Step 3 is *above* every mode, `yolo` included: a stored `deny` is the one
 * thing a mode cannot talk its way past. That is what lets a host confine an
 * agent to a directory (the `/workflow` worktree lanes do exactly this) rather
 * than merely ask it nicely — and why a denying rule may carry its own
 * {@link ExplainedPermissionRule.message}, since a wall the model cannot see
 * the shape of is a wall it will keep walking into.
 *
 * A wall is only a wall if it cannot be walked around by renaming the door.
 * Step 3's matching therefore compares path specifiers the way the filesystem
 * compares names — either separator, and case folded wherever the volume
 * folds it (see {@link defaultCaseInsensitivePaths}) — while commands and
 * URLs stay byte-exact. For the same reason a `"<prefix> *"` command rule is
 * quantified over shell segments by its own action rather than uniformly:
 * `every` for a grant, `any` for a refusal (see {@link SegmentPolicy}), since
 * a deny read as `every` switches off the moment anything is chained to it.
 */

import { statSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentEvent,
  PermissionAction,
  PermissionDecision,
  PermissionMode,
  PermissionPrompt,
  PermissionRequest,
  PermissionRequester,
  PermissionRule,
  PermissionScope,
} from "@arcturn/types";
import { resolveSubjectPath as resolveSubjectPathOnDisk } from "./subject-path.js";
import { createId } from "./util/ids.js";

/**
 * Tool names treated as non-mutating, and therefore usable in `plan` mode.
 *
 * `fetch` is deliberately absent: it reads nothing local but sends data to an
 * arbitrary host, so it is gated like a mutating tool and prompts per origin.
 */
export const DEFAULT_READ_ONLY_TOOLS: readonly string[] = ["read", "grep", "glob", "ls"] as const;

/** Tool names auto-approved by the `acceptEdits` mode. */
export const DEFAULT_EDIT_TOOLS: readonly string[] = ["write", "edit", "multiedit"] as const;

/** Pure-state tools owned by the runtime; never worth prompting about. */
export const DEFAULT_ALWAYS_ALLOW_TOOLS: readonly string[] = ["todo", "plan"] as const;

/** Construction options for {@link PermissionEngine}. */
export interface PermissionEngineOptions {
  /** Starting mode; defaults to `"default"`. */
  mode?: PermissionMode;
  /** Seed rules, evaluated in order within each scope. */
  rules?: PermissionRule[];
  /**
   * Resolves requests that rules do not settle (usually a UI prompt).
   * Receives the full request, `id` included, so hosts can correlate
   * decisions that arrive out of band.
   */
  requester?: PermissionPrompt;
  /** Invoked whenever a decision carries a `persistRule`, for durable storage. */
  onPersistRule?: (rule: PermissionRule) => void | Promise<void>;
  /** Overrides {@link DEFAULT_READ_ONLY_TOOLS}. */
  readOnlyTools?: string[];
  /** Overrides {@link DEFAULT_EDIT_TOOLS}. */
  editTools?: string[];
  /** Overrides {@link DEFAULT_ALWAYS_ALLOW_TOOLS}. */
  alwaysAllowTools?: string[];
  /**
   * Whether path specifiers and path subjects are compared case-insensitively.
   * Defaults to {@link defaultCaseInsensitivePaths}, i.e. to what the
   * filesystem actually does. Set it when the host knows better than the
   * probe — a case-sensitive volume mounted on macOS, or an agent whose
   * working tree lives on a different filesystem than the runtime.
   */
  caseInsensitivePaths?: boolean;
  /** Emits `permissionRequest` / `permissionDecision` events. */
  onEvent?: (event: AgentEvent) => void;
}

/** Everything the engine needs to resolve one permission check. */
export interface PermissionCheck {
  toolName: string;
  toolCallId: string;
  /** Value matched against rule specifiers (a command, a path, a URL, ...). */
  subject: string;
  /**
   * Other spellings of the same subject that a **`deny`** rule may also match.
   *
   * Asymmetric on purpose, and the asymmetry is the whole safety argument.
   * `subject` is the truthful one — the file the call really touches — and it
   * alone decides an `allow` or an `ask`, so no alternate spelling can widen a
   * grant. Alternates can only ever contribute a refusal.
   *
   * They exist because resolving a symlink moves a subject, and a subject that
   * moves can walk out from under a rule that was already refusing it. On
   * macOS `/var` is a symlink to `/private/var`, so a user's
   * `deny read "/var/log/**"` stops matching the moment the subject is
   * canonicalized; likewise `deny read "<cwd>/secrets/**"` stops matching when
   * `secrets` turns out to be a link elsewhere. Both used to fire. Matching the
   * pre-resolution spelling too keeps every deny that fired before firing now,
   * so closing the symlink hole cannot open a different one:
   * *what is refused after this change is a superset of what was refused
   * before it.*
   *
   * The prompt, the audit record and any suggested rule still name `subject`,
   * because that is the file the decision was really about.
   */
  alternateSubjects?: readonly string[];
  /** Human-readable summary rendered by prompts. */
  description?: string;
  /** Rule offered to the user for persistence when they approve. */
  suggestedRule?: Omit<PermissionRule, "scope">;
}

/**
 * A rule that explains itself when it denies.
 *
 * Additive to {@link @arcturn/types#PermissionRule}: the extra field is read
 * only on the deny path and only when it is a non-empty string, so a rule from
 * a config file, from a persisted "always allow" or from any existing caller
 * behaves exactly as it did before this existed.
 *
 * It exists because a rule-level deny is the *only* decision the model cannot
 * negotiate with — no prompt is raised, no mode overrides it — so it is also
 * the only one that has to teach. `Denied by permission rule for "write"` tells
 * a confined agent nothing it can act on; "you are in an isolated worktree at
 * /…/3-developer, write there with relative paths" tells it what to do next,
 * which is the difference between one wasted tool call and a step that loops
 * until its turn budget runs out.
 */
export interface ExplainedPermissionRule extends PermissionRule {
  /** Shown to the model instead of the generic denial text. */
  readonly message?: string;
}

/**
 * The denial text a matched rule asks for, when it asked for one.
 *
 * The cast is the whole point of {@link ExplainedPermissionRule} being
 * additive: rules reach the engine typed as plain `PermissionRule` from config
 * loaders and from hosts, and a rule that carries no message (every rule that
 * predates this) reads as `undefined` and falls back to the generic text.
 *
 * @param rule - The rule that matched, if any.
 */
function ruleDenialMessage(rule: PermissionRule | undefined): string | undefined {
  const message = (rule as ExplainedPermissionRule | undefined)?.message;
  return typeof message === "string" && message.trim() !== "" ? message : undefined;
}

const SCOPE_RANK: Record<PermissionScope, number> = { session: 0, project: 1, user: 2 };

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/* -------------------------------------------------------- path comparison */

/**
 * What a specifier and a subject are being compared *as*.
 *
 * `"path"` names a file, so the comparison follows the rules of the
 * filesystem that file lives on: `/` and `\` are the same separator, and two
 * spellings that differ only in case are the same file wherever the
 * filesystem says they are. `"text"` is compared verbatim — a command
 * (`argv` is case-sensitive on every platform, and a backslash inside a
 * command is an escape or an argument, not a separator) or a URL.
 */
export type SubjectKind = "path" | "text";

/** Options shared by everything that compares a path specifier to a subject. */
export interface PathMatchOptions {
  /**
   * Whether two path spellings differing only in case name the same file.
   * Defaults to {@link defaultCaseInsensitivePaths}, which asks the
   * filesystem rather than guessing from `process.platform`.
   */
  readonly caseInsensitivePaths?: boolean;
}

/**
 * How a `"<prefix> *"` command rule treats a subject that chains several
 * commands together.
 *
 * `"all"` — every runnable segment must match the prefix. Correct for a rule
 * that **grants**: approving `git status` may not also approve
 * `git status; rm -rf ~`.
 *
 * `"any"` — one matching segment is enough. Correct for a rule that
 * **refuses**: `deny bash "rm -rf *"` has to fire on `cd /tmp && rm -rf /etc`,
 * and under `"all"` it did not, because the harmless first segment failed the
 * prefix test and took the whole deny down with it.
 */
export type SegmentPolicy = "all" | "any";

/** Options for {@link matchSpecifier}. */
export interface SpecifierMatchOptions extends PathMatchOptions {
  /**
   * Force the comparison kind instead of inferring it with
   * {@link isPathLike}. A host that knows a tool's subject is a path (or a
   * command) can say so and skip the heuristic entirely.
   */
  readonly kind?: SubjectKind;
  /**
   * Quantifier applied to the shell segments of a chained subject by a
   * `"<prefix> *"` command rule. Defaults to `"all"`, the permissive-rule
   * reading; {@link matchRules} passes `"any"` for a `deny`.
   */
  readonly segments?: SegmentPolicy;
}

/** Options for {@link globToRegExp}. */
export interface GlobCompileOptions {
  /** Compile with the `i` flag. Defaults to `false`. */
  readonly caseInsensitive?: boolean;
}

/** Regex source matching either directory separator. */
const SEPARATOR = "[\\\\/]";
/** Regex source matching one character that is not a directory separator. */
const NON_SEPARATOR = "[^\\\\/]";

function isSeparator(char: string | undefined): boolean {
  return char === "/" || char === "\\";
}

/** Anything carrying a scheme (`https://`, `file://`) is a URL, not a path. */
const URL_SCHEME = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//;

/**
 * Whether a specifier or subject names a filesystem path rather than a
 * command line or a URL.
 *
 * Deliberately narrow, because the answer decides whether case is folded:
 * a value qualifies only when it contains a separator (or opens with `**`,
 * the documented way to anchor a path glob), carries no whitespace — a
 * command line has arguments, a path does not — and has no URL scheme. So
 * `**\/.env`, `/repo/src/**` and `C:\repo\.env` are paths; `git status`,
 * `rm -rf /` and `https://example.com/a` are not.
 *
 * A bare absolute executable (`/usr/local/bin/deploy`) does read as a path,
 * and that is correct rather than a miss: on a case-insensitive filesystem
 * it names the same binary however it is spelled.
 *
 * @param value - A rule specifier or a permission subject.
 */
export function isPathLike(value: string): boolean {
  if (value === "") return false;
  if (/\s/.test(value)) return false;
  if (URL_SCHEME.test(value)) return false;
  if (value.startsWith("**")) return true;
  return value.includes("/") || value.includes("\\");
}

/**
 * Decide how one comparison is made: a path comparison when *either* side
 * looks like a path.
 *
 * "Either" is the security-relevant half. The specifier comes from a config
 * file or from a prompt the user answered — never from the model — so a rule
 * written as a path is compared as a path however the subject is spelled,
 * and the model cannot demote a path deny to a verbatim comparison by
 * choosing a subject that reads as something else: `deny **\/*.env` still
 * covers `/repo/my secret.ENV`, which a subject-shaped test alone would call
 * a command line because it contains a space. The subject side then catches
 * the reverse case, where an absolute subject is matched against a bare
 * specifier such as `*.pem`.
 */
function subjectKindOf(specifier: string, subject: string): SubjectKind {
  return isPathLike(specifier) || isPathLike(subject) ? "path" : "text";
}

/** Fold a path to its comparison key: one separator, optionally one case. */
function canonicalPath(value: string, caseInsensitive: boolean): string {
  const separated = value.replace(/\\/g, "/");
  return caseInsensitive ? separated.toLowerCase() : separated;
}

/**
 * The platform's *usual* filesystem, used only when the probe below cannot
 * run. Windows volumes are case-insensitive without exception, and macOS
 * formats APFS case-insensitively by default; Linux filesystems are
 * case-sensitive.
 */
const PLATFORM_CASE_INSENSITIVE = process.platform === "win32" || process.platform === "darwin";

let probedCaseInsensitive: boolean | undefined;

/**
 * Flip the case of a path's last segment, or `undefined` when it has no
 * letters to flip.
 */
function flipFileNameCase(path: string): string | undefined {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const base = path.slice(cut + 1);
  const flipped = base.replace(/[a-zA-Z]/g, (char) =>
    char === char.toLowerCase() ? char.toUpperCase() : char.toLowerCase(),
  );
  return flipped === base ? undefined : path.slice(0, cut + 1) + flipped;
}

/**
 * Ask the filesystem — this module's own file — whether it is
 * case-insensitive, by `stat`ing that file under a case-flipped name and
 * comparing inode and device. `ENOENT` is itself the answer (case-sensitive);
 * any other failure means "could not tell".
 */
function probeFilesystemCaseInsensitivity(): boolean | undefined {
  try {
    const self = fileURLToPath(import.meta.url);
    const flipped = flipFileNameCase(self);
    if (flipped === undefined) return undefined;
    const mine = statSync(self);
    try {
      const other = statSync(flipped);
      return other.ino === mine.ino && other.dev === mine.dev;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return code === "ENOENT" || code === "ENOTDIR" ? false : undefined;
    }
  } catch {
    return undefined;
  }
}

/**
 * Whether path comparison should ignore case here.
 *
 * Decided **per filesystem, not per platform**: the question a permission
 * rule is really asking is "do these two spellings open the same file?", and
 * that is a property of the volume. So this probes the real filesystem once
 * (see {@link probeFilesystemCaseInsensitivity}) and memoizes the answer,
 * falling back to the platform's usual formatting only when the probe cannot
 * run. A `process.platform === "win32"` test would have missed the default
 * macOS install entirely, which is where this defect was live.
 *
 * **The tradeoff, stated plainly.** Case-insensitive matching makes a `deny`
 * strictly safer — `deny **\/.env` now also refuses `.ENV`, `.Env` and every
 * other spelling of the same bytes, where before each was a free bypass. It
 * makes an `allow` correspondingly broader: `allow write /repo/src/**` also
 * allows `/REPO/SRC/x.ts`. On a case-insensitive filesystem those *are* the
 * same files, so the grant is not actually wider than the user drew it; on a
 * case-sensitive one they are different files, which is exactly why this is
 * decided by the filesystem instead of being hardcoded on.
 *
 * A host that knows better — a case-sensitive volume mounted on macOS, a
 * subject tree on a different filesystem than this module — overrides it per
 * call via {@link PathMatchOptions.caseInsensitivePaths}, or for a whole
 * engine via {@link PermissionEngineOptions.caseInsensitivePaths}.
 */
export function defaultCaseInsensitivePaths(): boolean {
  probedCaseInsensitive ??= probeFilesystemCaseInsensitivity() ?? PLATFORM_CASE_INSENSITIVE;
  return probedCaseInsensitive;
}

/**
 * Compile a simple path glob into a regular expression.
 *
 * `**` crosses directory separators, `*` does not, and `?` matches one
 * non-separator character. **Both `/` and `\` are separators**, on every
 * platform and in both the pattern and the subject: a subject reaches the
 * engine from `path.resolve`, so on Windows it is spelled with backslashes,
 * and a pattern written either way has to keep meaning what it says. Two
 * things follow, and both are the point:
 *
 * - `**\/.env` — the deny rule the permissions doc tells users to write —
 *   compiles to `^(?:.*[\\/])?\.env$` and therefore matches `C:\repo\.env`.
 *   Anchored on `/` alone it matched no Windows path at all, i.e. the
 *   documented way to protect secrets was silently inert.
 * - `C:\repo\*` cannot widen into a subtree grant. With `*` compiled as
 *   `[^/]*` it ate backslashes, so a rule naming one directory also granted
 *   `C:\repo\secrets\deep\prod.env`.
 *
 * A backslash is consequently *not* an escape character here; it never was
 * (it compiled to a literal backslash), and globs have no escape syntax.
 *
 * @param pattern - Glob pattern such as `"src/**\/*.ts"`.
 * @param options - Set `caseInsensitive` to compile with the `i` flag.
 */
export function globToRegExp(pattern: string, options: GlobCompileOptions = {}): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]!;
    if (char === "*") {
      const isDouble = pattern[i + 1] === "*";
      if (isDouble) {
        i++;
        if (isSeparator(pattern[i + 1])) {
          i++;
          out += `(?:.*${SEPARATOR})?`;
        } else {
          out += ".*";
        }
      } else {
        out += `${NON_SEPARATOR}*`;
      }
      continue;
    }
    if (char === "?") {
      out += NON_SEPARATOR;
      continue;
    }
    if (isSeparator(char)) {
      out += SEPARATOR;
      continue;
    }
    out += escapeRegExp(char);
  }
  return new RegExp(`^${out}$`, options.caseInsensitive === true ? "i" : "");
}

/**
 * Split a shell command on the operators that chain or redirect commands, so
 * each runnable segment can be matched separately.
 *
 * Quoting is not interpreted: an operator inside quotes still splits, which
 * over-splits rather than under-splits and so cannot widen a rule.
 */
export function shellSegments(command: string): string[] {
  return command
    .split(/(?:\|\||&&|[;&|\n]|\$\(|`|<\(|>\()/g)
    .map((segment) => segment.replace(/^[\s()]+|[\s()]+$/g, ""))
    .filter((segment) => segment.length > 0);
}

/**
 * Test a rule specifier against a permission subject.
 *
 * Supported forms: `undefined`/`"*"` (everything), a `"git *"` style command
 * prefix, a glob containing `*` or `?`, or an exact string.
 *
 * A `"git *"` prefix grants the *whole* subject only when every chained shell
 * segment matches the prefix, so approving `git status` never also approves
 * `git status; rm -rf ~`. A *denying* rule reads the same specifier the other
 * way round — one matching segment is enough — because the quantifier that
 * makes a grant narrow makes a refusal escapable: see {@link SegmentPolicy}
 * and {@link SpecifierMatchOptions.segments}, which {@link matchRules} sets
 * from the rule's own action.
 *
 * Path specifiers and path subjects are compared the way the filesystem
 * compares them — either separator, and case-insensitively where the volume
 * is (see {@link defaultCaseInsensitivePaths}). Commands and URLs are
 * compared verbatim; {@link isPathLike} decides which of the two a
 * comparison is, and {@link SpecifierMatchOptions.kind} overrides it.
 *
 * @param specifier - The rule specifier.
 * @param subject - The subject of the current tool call.
 * @param options - Case policy, and an optional forced {@link SubjectKind}.
 */
export function matchSpecifier(
  specifier: string | undefined,
  subject: string,
  options: SpecifierMatchOptions = {},
): boolean {
  if (specifier === undefined || specifier === "*") return true;
  if (specifier.endsWith(" *")) {
    const prefix = specifier.slice(0, -2);
    const matchesPrefix = (value: string) => value === prefix || value.startsWith(`${prefix} `);
    const segments = shellSegments(subject);
    if (segments.length === 0) return false;
    // A grant needs every segment; a refusal needs only one. See
    // {@link SegmentPolicy} — reading `any` as `all` on the deny path is how
    // `deny bash "rm -rf *"` came to ignore `cd /tmp && rm -rf /etc`.
    return options.segments === "any"
      ? segments.some(matchesPrefix)
      : segments.every(matchesPrefix);
  }
  const kind = options.kind ?? subjectKindOf(specifier, subject);
  const caseInsensitive =
    kind === "path" && (options.caseInsensitivePaths ?? defaultCaseInsensitivePaths());
  if (specifier.includes("*") || specifier.includes("?")) {
    return globToRegExp(specifier, { caseInsensitive }).test(subject);
  }
  if (specifier === subject) return true;
  // An exact path rule is still a path rule: `/home/me/.env` has to deny
  // `/home/me/.ENV` on a case-insensitive volume, and `C:/repo/.env` has to
  // deny the `C:\repo\.env` that `path.resolve` actually produces there.
  if (kind === "text") return false;
  return canonicalPath(specifier, caseInsensitive) === canonicalPath(subject, caseInsensitive);
}

function specificity(rule: PermissionRule): number {
  const toolScore = rule.tool === "*" ? 0 : 2;
  const specifier = rule.specifier;
  const specifierScore =
    specifier === undefined || specifier === "*"
      ? 0
      : specifier.includes("*") || specifier.includes("?")
        ? 1
        : 2;
  return toolScore + specifierScore;
}

/**
 * Ordered rule store with scope precedence.
 *
 * Exposed separately from the engine so hosts can reuse the matching logic
 * (for example to preview which rule would fire).
 *
 * @param rules - The rules to search, in insertion order.
 * @param toolName - The tool being invoked.
 * @param subject - The subject matched against each rule's specifier.
 * @param options - Path-comparison policy, forwarded to {@link matchSpecifier}.
 */
export function matchRules(
  rules: readonly PermissionRule[],
  toolName: string,
  subject: string,
  options: PathMatchOptions = {},
): PermissionRule | undefined {
  const candidates = rules
    .map((rule, index) => ({ rule, index }))
    .filter(
      ({ rule }) =>
        (rule.tool === "*" || rule.tool === toolName) &&
        // The action decides how a chained command subject is quantified: a
        // grant needs every segment, a refusal needs one. Deciding it here,
        // where the rule is in hand, is what keeps every caller of the engine
        // — `check`, `evaluate`, a host previewing a rule — on the same
        // reading. See {@link SegmentPolicy}.
        matchSpecifier(rule.specifier, subject, {
          ...options,
          segments: rule.action === "deny" ? "any" : "all",
        }),
    );
  if (candidates.length === 0) return undefined;

  const byPrecedence = (a: { rule: PermissionRule; index: number }, b: typeof a) => {
    const scope = SCOPE_RANK[a.rule.scope] - SCOPE_RANK[b.rule.scope];
    if (scope !== 0) return scope;
    const spec = specificity(b.rule) - specificity(a.rule);
    if (spec !== 0) return spec;
    // A deny is the safer outcome when two equally specific rules disagree.
    const denyBias = (a.rule.action === "deny" ? 0 : 1) - (b.rule.action === "deny" ? 0 : 1);
    if (denyBias !== 0) return denyBias;
    return a.index - b.index;
  };

  const sorted = [...candidates].sort(byPrecedence);
  const winner = sorted[0]!;

  // A deny beats a permissive rule from a nearer scope unless that rule is
  // STRICTLY more specific. Scope precedence alone would let a project-scoped
  // allow override a user-scoped deny, so a checked-in config could escalate
  // its own privileges just by being cloned.
  //
  // The comparison is `>=`, not `>`, and the difference is the whole point.
  // With `>`, a project `allow write "**\/.env"` tied the user's own
  // `deny write "**\/.env"` on specificity, won on scope, and cancelled it —
  // the escape needed no cleverness at all, just the same rule written the
  // other way round in a repository someone cloned. `>=` makes the deny bias
  // that already settles a tie *within* one scope settle it across scopes too,
  // which is the only reading under which "a deny is the one thing a mode
  // cannot talk its way past" also survives a config file it did not write.
  //
  // A strictly more specific permissive rule still wins, which is what the
  // "allow narrowly, deny widely" cookbook shape depends on: `allow edit
  // "**\/src\/**\/*.ts"` (3) over `deny edit "*"` (2) still edits `src`.
  const bestDeny = sorted.find(({ rule }) => rule.action === "deny");
  if (bestDeny && specificity(bestDeny.rule) >= specificity(winner.rule)) {
    return bestDeny.rule;
  }
  return winner.rule;
}

/**
 * {@link matchRules}, then the same question again for each alternate spelling
 * of the subject, keeping only a `deny` from those.
 *
 * See {@link PermissionCheck.alternateSubjects} for why alternates may refuse
 * but never grant. Costs one extra {@link matchRules} pass per alternate, and
 * the loop passes an alternate only when resolving symlinks actually moved the
 * subject — which is to say almost never.
 *
 * @param rules - The rules to search.
 * @param toolName - The tool being invoked.
 * @param subject - The truthful subject; decides allow and ask.
 * @param alternates - Other spellings of the same subject.
 * @param options - Path-comparison policy, forwarded to {@link matchRules}.
 */
function matchRulesAcrossSpellings(
  rules: readonly PermissionRule[],
  toolName: string,
  subject: string,
  alternates: readonly string[] | undefined,
  options: PathMatchOptions = {},
): PermissionRule | undefined {
  const primary = matchRules(rules, toolName, subject, options);
  if (primary?.action === "deny" || alternates === undefined) return primary;
  for (const alternate of alternates) {
    if (alternate === subject) continue;
    const matched = matchRules(rules, toolName, alternate, options);
    if (matched?.action === "deny") return matched;
  }
  return primary;
}

/** Rule-based allow/deny/ask engine with session, project and user scopes. */
export class PermissionEngine {
  #mode: PermissionMode;
  #rules: PermissionRule[];
  #requester: PermissionPrompt | undefined;
  #onPersistRule: ((rule: PermissionRule) => void | Promise<void>) | undefined;
  #readOnlyTools: Set<string>;
  #editTools: Set<string>;
  #alwaysAllowTools: Set<string>;
  #onEvent: ((event: AgentEvent) => void) | undefined;
  /** Path-comparison policy, forwarded to every {@link matchRules} call. */
  #pathMatch: PathMatchOptions;
  /** Deduplicates repeat asks within a single tool call. */
  #callCache = new Map<string, PermissionDecision>();

  constructor(options: PermissionEngineOptions = {}) {
    this.#mode = options.mode ?? "default";
    this.#rules = [...(options.rules ?? [])];
    this.#requester = options.requester;
    this.#onPersistRule = options.onPersistRule;
    this.#readOnlyTools = new Set(options.readOnlyTools ?? DEFAULT_READ_ONLY_TOOLS);
    this.#editTools = new Set(options.editTools ?? DEFAULT_EDIT_TOOLS);
    this.#alwaysAllowTools = new Set(options.alwaysAllowTools ?? DEFAULT_ALWAYS_ALLOW_TOOLS);
    this.#onEvent = options.onEvent;
    this.#pathMatch =
      options.caseInsensitivePaths === undefined
        ? {}
        : { caseInsensitivePaths: options.caseInsensitivePaths };
  }

  /** The active permission mode. */
  get mode(): PermissionMode {
    return this.#mode;
  }

  /** Replace the active permission mode. */
  setMode(mode: PermissionMode): void {
    this.#mode = mode;
  }

  /**
   * A snapshot of the engine's *effective* rules, in insertion order: the seed
   * rules it was constructed with plus everything {@link PermissionEngine.addRule}
   * has appended since — which includes every rule a live prompt handed back as
   * {@link @arcturn/types#PermissionDecision.persistRule}, i.e. each "always
   * allow" the user has clicked during this run.
   *
   * The array is a fresh copy and the rules in it are the engine's own frozen-by
   * -convention records: reading is non-mutating, and pushing to the result
   * changes nothing here.
   *
   * This is the accessor a host reads when it needs to seed a *second* engine —
   * a sub-agent's, say — with what the user has actually approved so far,
   * rather than with only what was on disk at startup. Seeding a child from
   * this snapshot can only ever hand it MORE rules than the config file did,
   * denies included; it never drops one.
   */
  get rules(): readonly PermissionRule[] {
    return [...this.#rules];
  }

  /** Replace the requester used for unmatched checks. */
  setRequester(requester: PermissionPrompt | undefined): void {
    this.#requester = requester;
  }

  /** Subscribe the engine to an event sink. */
  setEventSink(onEvent: ((event: AgentEvent) => void) | undefined): void {
    this.#onEvent = onEvent;
  }

  /**
   * Append a rule. Later rules lose ties against earlier ones of equal
   * scope and specificity.
   *
   * @param rule - Rule to add.
   */
  addRule(rule: PermissionRule): void {
    this.#rules.push(rule);
  }

  /** Drop every rule of a given scope (defaults to `"session"`). */
  clearRules(scope?: PermissionScope): void {
    this.#rules = scope === undefined ? [] : this.#rules.filter((rule) => rule.scope !== scope);
  }

  /** Whether a tool is considered non-mutating (usable in `plan` mode). */
  isReadOnlyTool(toolName: string): boolean {
    return this.#readOnlyTools.has(toolName) || this.#alwaysAllowTools.has(toolName);
  }

  /** Whether a tool is auto-approved by `acceptEdits`. */
  isEditTool(toolName: string): boolean {
    return this.#editTools.has(toolName);
  }

  /**
   * Match stored rules only — no mode behaviour, no prompting.
   *
   * @param toolName - Tool being invoked.
   * @param subject - Subject matched against rule specifiers.
   * @returns The matched action, or `"ask"` when nothing matches.
   */
  evaluate(toolName: string, subject: string): PermissionAction {
    return matchRules(this.#rules, toolName, subject, this.#pathMatch)?.action ?? "ask";
  }

  /** Forget cached decisions taken during one tool call. */
  clearCallCache(toolCallId: string): void {
    for (const key of [...this.#callCache.keys()]) {
      if (key.startsWith(`${toolCallId} `)) this.#callCache.delete(key);
    }
  }

  /**
   * Fully resolve a permission check, prompting if necessary.
   *
   * @param check - The tool call being gated.
   * @returns An allow or deny decision; never `"ask"`.
   */
  async check(check: PermissionCheck): Promise<PermissionDecision> {
    const requestId = createId("perm");

    if (this.#alwaysAllowTools.has(check.toolName)) {
      // Emitted, so "every check emits exactly one permissionDecision"
      // (see the module doc) is true of this branch too. The list is
      // overridable, and a host that puts something with teeth on it must
      // not get an allow that leaves no trace in the audit trail.
      const allowed: PermissionDecision = { requestId, behavior: "allow" };
      this.#emit({ type: "permissionDecision", decision: allowed });
      return allowed;
    }

    // The TOOL NAME belongs in this key because it is half of what the
    // rules matched on. Keyed by `toolCallId + subject` alone, a tool that
    // asked under one name and then under another within the same call was
    // handed the first answer back from cache — so an `allow` for a
    // harmless name served a `deny`d one on the same subject, and the deny
    // rule never ran. `requestPermission` takes `toolName` from its caller,
    // so any tool, MCP bridge or extension could reach it.
    const cacheKey = `${check.toolCallId} ${check.toolName} ${check.subject}`;
    const cached = this.#callCache.get(cacheKey);
    if (cached) return cached;

    const request: PermissionRequest = {
      id: requestId,
      toolName: check.toolName,
      toolCallId: check.toolCallId,
      subject: check.subject,
      description: check.description ?? describeCheck(check),
      ...(check.suggestedRule === undefined ? {} : { suggestedRule: check.suggestedRule }),
    };

    // `permissionRequest` is emitted by #resolve only when the user is really
    // being asked. Emitting it for checks the rules already settled would make
    // a UI raise a prompt for, say, every file read, and would mislead any host
    // that tracks outstanding requests.
    const decision = await this.#resolve(request, check.alternateSubjects);
    if (decision.persistRule) {
      this.addRule(decision.persistRule);
      await this.#onPersistRule?.(decision.persistRule);
    }
    this.#callCache.set(cacheKey, decision);
    this.#emit({ type: "permissionDecision", decision });
    return decision;
  }

  /**
   * A {@link PermissionRequester} bound to one tool call, suitable for
   * {@link @arcturn/types#ToolExecutionContext.requestPermission}.
   *
   * @param toolCallId - The tool call the requester belongs to.
   */
  requesterFor(toolCallId: string): PermissionRequester {
    return (request) =>
      this.check({
        toolName: request.toolName,
        toolCallId: request.toolCallId || toolCallId,
        subject: request.subject,
        description: request.description,
        ...(request.suggestedRule === undefined ? {} : { suggestedRule: request.suggestedRule }),
      });
  }

  /**
   * Ask the injected requester directly, bypassing rules and modes.
   *
   * Used by the plan-mode exit gate, where stored rules must not be able to
   * pre-approve leaving plan mode.
   *
   * @param request - The request to put to the user.
   */
  async ask(request: Omit<PermissionRequest, "id">): Promise<PermissionDecision> {
    const full: PermissionRequest = { ...request, id: createId("perm") };
    this.#emit({ type: "permissionRequest", request: full });
    const decision = this.#requester
      ? await this.#requester(full)
      : {
          requestId: full.id,
          behavior: "deny" as const,
          message: "No permission requester is configured.",
        };
    const normalized: PermissionDecision = { ...decision, requestId: full.id };
    this.#emit({ type: "permissionDecision", decision: normalized });
    return normalized;
  }

  async #resolve(
    request: PermissionRequest,
    alternateSubjects?: readonly string[],
  ): Promise<PermissionDecision> {
    const { id: requestId, toolName, subject } = request;

    if (this.#mode === "plan" && !this.isReadOnlyTool(toolName)) {
      return {
        requestId,
        behavior: "deny",
        message:
          `Plan mode is active: "${toolName}" cannot run because it may modify state. ` +
          "Present a plan with the plan tool and wait for approval.",
      };
    }

    // The matched rule, not just its action: a deny may explain itself, and
    // this is the one decision the model gets no prompt to argue with.
    const rule = matchRulesAcrossSpellings(
      this.#rules,
      toolName,
      subject,
      alternateSubjects,
      this.#pathMatch,
    );
    const action = rule?.action ?? "ask";
    if (action === "deny") {
      return {
        requestId,
        behavior: "deny",
        message: ruleDenialMessage(rule) ?? `Denied by permission rule for "${toolName}".`,
      };
    }
    if (action === "allow") return { requestId, behavior: "allow" };

    // Read-only tools are allowed unless a rule says otherwise; prompting for
    // every file read would make the default mode unusable.
    if (this.isReadOnlyTool(toolName)) return { requestId, behavior: "allow" };

    if (this.#mode === "yolo") return { requestId, behavior: "allow" };
    if (this.#mode === "acceptEdits" && this.isEditTool(toolName)) {
      return { requestId, behavior: "allow" };
    }

    if (!this.#requester) {
      return {
        requestId,
        behavior: "deny",
        message: `Permission required for "${toolName}" but no permission requester is configured.`,
      };
    }

    this.#emit({ type: "permissionRequest", request });
    const decision = await this.#requester(request);
    return { ...decision, requestId };
  }

  #emit(event: AgentEvent): void {
    this.#onEvent?.(event);
  }
}

function describeCheck(check: PermissionCheck): string {
  return check.subject ? `Run ${check.toolName}: ${check.subject}` : `Run ${check.toolName}`;
}

const SUBJECT_KEYS = [
  "command",
  "file_path",
  "filePath",
  "path",
  "url",
  "pattern",
  "query",
  "target",
] as const;

/** Subject keys naming a filesystem path, normalized before rules are matched. */
const PATH_SUBJECT_KEYS = new Set<string>(["file_path", "filePath", "path", "target"]);

/**
 * The first well-known argument a tool call carries, and whether it names a
 * file. Shared by {@link defaultSubject} and {@link resolveSubject} so the two
 * can never pick different arguments out of the same call.
 */
function subjectArgument(
  input: Record<string, unknown>,
): { value: string; isPath: boolean } | undefined {
  for (const key of SUBJECT_KEYS) {
    const value = input[key];
    if (typeof value !== "string" || value.length === 0) continue;
    return { value, isPath: PATH_SUBJECT_KEYS.has(key) };
  }
  return undefined;
}

/**
 * Derive the permission subject for a tool call from its arguments.
 *
 * Well-known argument names (`command`, `path`, `url`, ...) win; otherwise the
 * subject is empty, which only matches wildcard rules.
 *
 * Path-valued subjects are resolved against `cwd` and normalized, so that
 * `.env`, `./.env` and `/repo/sub/../.env` all present the same subject to the
 * rules — otherwise a deny rule written with an absolute path would not match
 * the same file named relatively.
 *
 * Separator and case are deliberately *not* folded here. The subject is also
 * what a prompt shows the user and what the audit log records, so it keeps
 * the spelling the tool call actually used; the filesystem's own rules for
 * comparing two spellings are applied at match time instead, by
 * {@link matchSpecifier}.
 *
 * **Synchronous and pure, deliberately.** This is what the CLI's transcript
 * formatter (`display.ts`), its audit log and its provenance report call to
 * *draw a line*, once per rendered tool call and often per frame. It resolves
 * `..` lexically and touches nothing; symlinks are resolved by
 * {@link resolveSubject}, which is what the loop hands the engine, so a
 * renderer never pays for a `realpath`.
 *
 * @param _toolName - The tool being invoked (reserved for future overrides).
 * @param input - The tool call arguments.
 * @param cwd - Working directory used to resolve path subjects.
 */
export function defaultSubject(
  _toolName: string,
  input: Record<string, unknown>,
  cwd?: string,
): string {
  const argument = subjectArgument(input);
  if (argument === undefined) return "";
  if (cwd !== undefined && argument.isPath) return resolvePath(cwd, argument.value);
  return argument.value;
}

/**
 * The subject the **rules** are matched against: {@link defaultSubject}, with a
 * path argument re-spelled as the file it actually opens.
 *
 * The difference is the whole wall. `read`, `grep`, `glob` and `ls` are in
 * {@link DEFAULT_READ_ONLY_TOOLS}: they never call `requestPermission`, so a
 * stored `deny` matched against this subject is the only thing standing in
 * front of them — and a stored `deny` is the one decision no mode, `yolo`
 * included, can override. Matched against a lexical subject it was walkable
 * with an ordinary symlink: `deny read <home>/.ssh/**` refused
 * `read("<home>/.ssh/id_rsa")` and allowed `read("keys/id_rsa")` through a
 * `keys -> <home>/.ssh` link, and the key bytes came back in the tool result.
 *
 * Only path-valued arguments are touched, and only when a `cwd` is given: a
 * `command` or a `url` is not a path and is never rewritten. A link that stays
 * inside the workspace stays ordinary — see {@link resolveSubjectPath}, which
 * rewrites exactly the case that lies and explains why a resolution failure
 * degrades to the lexical answer rather than refusing.
 *
 * `await`ed at one call site, `executeToolCall` in `loop.ts`, which is already
 * async and already about to touch the filesystem anyway.
 *
 * @param _toolName - The tool being invoked (reserved, as in
 *   {@link defaultSubject}, for future per-tool subject overrides).
 * @param input - The tool call arguments.
 * @param cwd - Working directory used to resolve path subjects.
 */
export async function resolveSubject(
  _toolName: string,
  input: Record<string, unknown>,
  cwd?: string,
): Promise<string> {
  const argument = subjectArgument(input);
  if (argument === undefined) return "";
  if (cwd === undefined || !argument.isPath) return argument.value;
  const lexical = resolvePath(cwd, argument.value);
  try {
    return await resolveSubjectPathOnDisk(cwd, lexical);
  } catch {
    // `resolveSubjectPath` catches its own filesystem errors, so reaching here
    // means something unforeseen. Fall back to the lexical subject — the
    // subject this returned before symlinks were resolved at all — rather than
    // failing the tool call: see the failure-direction note in
    // `subject-path.ts`. A degraded subject leaves the old wall standing; a
    // thrown error would take down a call the rules may well have allowed.
    return lexical;
  }
}
