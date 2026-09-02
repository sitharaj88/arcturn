/**
 * `arcturn doctor` — probe every configured provider endpoint with its real
 * key and print a per-endpoint verdict.
 *
 * The failure this exists for is not a missing key but a *misrouted* one: a
 * Z.AI key with an active coding plan pointed at the general endpoint answers
 * "429 Insufficient balance" (Z.AI code 1113) — a message that reads as a
 * billing problem when the actual problem is the base URL, and that cost an
 * hour to root-cause the day before this command existed. Doctor sends each
 * endpoint a one-token completion with retries off, reads the typed error off
 * the stream, and says which of "auth failed", "no balance", "rate limited",
 * "network" or "unknown model" actually came back — plus, for providers with
 * sibling endpoints, which sibling the key may belong to.
 *
 * Never printed here, under any verdict: key material. Not even a prefix —
 * the environment is read only to answer *whether* and *which variable*, the
 * same rule the provider catalog follows.
 */

import {
  createClient,
  DEFAULT_API_KEY_ENV,
  discoverModels,
  FALLBACK_API_KEY_ENV,
  getModel,
  listModels,
  listProviderIds,
  PROVIDER_PRESETS,
  presetSpec,
  resolveApiKey,
  subscriptionPlanFor,
} from "@arcturn/ai";
import type { AIError, LLMClient, ModelSpec } from "@arcturn/types";
import type { DoctorCommand } from "./args.js";
import { type ArcturnConfig, isLocalEndpoint, loadConfig } from "./config.js";
import type { EnvMap } from "./paths.js";
import {
  configuredProviderSpec,
  configuredProviderStatuses,
  declaredProvider,
  registerConfiguredProviders,
} from "./providers.js";
import { ROUTE_KINDS } from "./router.js";
import { registerBundledCatalog } from "./runtime.js";

/** Options threaded through for tests, mirroring `RunMcpCommandOptions`. */
export interface RunDoctorCommandOptions {
  readonly cwd?: string;
  readonly env?: EnvMap;
  readonly stdout?: (text: string) => void;
  readonly stderr?: (text: string) => void;
  /**
   * Probe transport; tests inject a scripted client. The default is a real
   * `createClient` with retries off — see {@link runDoctorCommand} for why.
   */
  readonly client?: LLMClient;
  /** Fetch used to discover a model id for presets with no curated entry. */
  readonly fetchFn?: typeof fetch;
  /** Per-probe wall-clock deadline in milliseconds. */
  readonly timeoutMs?: number;
  /** `--model`: wire model id to probe; valid only with an explicit preset. */
  readonly model?: string;
}

/**
 * Wall-clock ceiling on one probe. Generous enough for a cold connection to a
 * far region, short enough that a dead endpoint cannot hold the report past
 * the point anyone is still watching.
 */
const DEFAULT_PROBE_DEADLINE_MS = 15_000;

/**
 * Idle-stall watchdog for probes, far below the client default (120s): a
 * one-token completion answers within seconds or not at all.
 */
const PROBE_STALL_TIMEOUT_MS = 10_000;

/** Probes in flight at once. Small: this is a health check, not a load test. */
const PROBE_POOL_SIZE = 6;

/**
 * Registered base providers `doctor <name>` also accepts alongside the
 * `PROVIDER_PRESETS` table — the direct, single-key-variable adapters with a
 * curated model catalog. `--help` and the docs describe `doctor [preset]` as
 * probing a *provider* endpoint, and these three are the base providers a
 * plain `provider/model` id (no preset) resolves through; `--list-providers`
 * lists more (openai-compatible, azure, vertex, bedrock, …) but those need a
 * baseUrl or ambient credentials a bare name cannot supply.
 */
const BASE_PROVIDERS = ["openai", "anthropic", "google"] as const;

/**
 * Z.AI's "insufficient balance" answer: numeric code 1113, and the English or
 * Chinese phrase, since which one comes back depends on the endpoint region.
 * It arrives as a 429 and is classified `rateLimit` upstream, but waiting and
 * retrying will never fix it — the fix is a different endpoint or a top-up,
 * so it gets its own verdict here. No other code in the repo knows 1113.
 */
const NO_BALANCE_PATTERN = /\b1113\b|insufficient balance|余额不足/i;

/**
 * The not-found shapes providers actually flatten into an invalid-request
 * message for a bad model id. Deliberately tighter than "mentions the word
 * model": a 400 like "max_tokens exceeds this model's limit" mentions the
 * model while diagnosing the request, and calling it "unknown model" sends
 * the operator to fix an id that is fine. Anything ambiguous falls through to
 * the generic error verdict, which shows the status and message verbatim.
 *
 * - `model … not found / does not exist / no such / unknown`: OpenAI ("The
 *   model `x` does not exist or you do not have access to it") and Google
 *   ("models/x is not found for API version …") prose.
 * - `no such / unknown / invalid model`: the reversed prose order.
 * - `model_not_found`: OpenAI's structured error code, when a gateway
 *   surfaces it in the text.
 * - `not_found_error`: the Anthropic SDK stringifies the whole 404 body into
 *   the message (`{"type":"not_found_error","message":"model: x"}`), so the
 *   type tag precedes the word "model" and prose order cannot match.
 */
const UNKNOWN_MODEL_PATTERN = new RegExp(
  [
    String.raw`model[\s\S]{0,80}?(not.?found|does not exist|no such|unknown)`,
    String.raw`(no such|unknown|invalid)\s+model`,
    "model_not_found",
    "not_found_error",
  ].join("|"),
  "i",
);

/** One report row's classification. */
interface Verdict {
  /** Short classification, the report's second column. */
  word: string;
  /** Everything after the verdict: status, message, latency, key facts. */
  detail: string;
  /** Advice rendered on its own indented line under the row. */
  hint?: string;
  /** Whether this row makes the run exit 1. */
  failed: boolean;
}

/** One endpoint to check: a spec to probe, or a verdict already decided. */
interface ProbeTarget {
  /** First column: preset name, or the model id for config-referenced rows. */
  name: string;
  /** Preset behind this target, when there is one (key facts, sibling hints). */
  preset?: string;
  /** Config keys that referenced this endpoint; empty for the key scan. */
  labels: string[];
  /** Absent when {@link pre} decided the row without a network round-trip. */
  spec?: ModelSpec;
  /** A verdict reached without probing (no key, placeholder URL, …). */
  pre?: Verdict;
}

/** A finished row: target name plus its decorated verdict. */
interface ProbeRow {
  name: string;
  verdict: Verdict;
}

/** What one probe observed on the wire. */
interface ProbeOutcome {
  error?: AIError;
  latencyMs: number;
  outputTokens?: number;
}

/**
 * Execute a parsed `arcturn doctor` command.
 *
 * @returns Process exit code: `0` when everything probed answered (or there
 *   was nothing to probe), `1` when at least one check failed, `2` on a usage
 *   error.
 */
export async function runDoctorCommand(
  command: DoctorCommand,
  options: RunDoctorCommandOptions = {},
): Promise<number> {
  const out = options.stdout ?? ((text: string) => process.stdout.write(text));
  const err = options.stderr ?? ((text: string) => process.stderr.write(text));
  const env = options.env ?? process.env;
  // Presets must be in the catalog before any id is resolved, for the same
  // reason every listing surface registers them: the curated head is the
  // model a probe speaks, and config ids resolve against the same table.
  registerBundledCatalog();

  if (command.preset === undefined && options.model !== undefined) {
    err("arcturn: doctor --model needs a preset to probe (arcturn doctor <preset> --model <id>)\n");
    return 2;
  }

  let targets: ProbeTarget[];
  let trailer: string[] = [];
  if (command.preset !== undefined) {
    const entry = PROVIDER_PRESETS[command.preset];
    if (entry === undefined) {
      if ((BASE_PROVIDERS as readonly string[]).includes(command.preset)) {
        targets = [await providerTarget(command.preset, env, options)];
      } else {
        const validPresets = Object.keys(PROVIDER_PRESETS).sort().join(", ");
        const validProviders = listProviderIds().join(", ");
        err(
          `arcturn: unknown preset or provider "${command.preset}". Valid presets: ` +
            `${validPresets}. Registered providers: ${validProviders}\n`,
        );
        // "doctor" is an ordinary English verb, so an unquoted prompt lands
        // here; same escape hatch the registry verbs print on their exit 2.
        err(`arcturn: to send this as a prompt instead, quote it: arcturn "doctor ..."\n`);
        return 2;
      }
    } else {
      targets = [await presetTarget(command.preset, env, options)];
    }
  } else {
    const loaded = await loadConfig({
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      env,
    });
    for (const warning of loaded.warnings) err(`arcturn: ${warning}\n`);
    // Config-declared endpoints join the catalog so a `mycorp/…` id in this
    // config resolves to a real spec. No confirmer is passed and none may
    // ever be: doctor sends the real key with real credentials by design, so
    // a run against a freshly cloned hostile repo must not be the thing that
    // delivers it. A project-declared endpoint therefore stays inert and gets
    // the "not enabled" pre-verdict below instead of a probe.
    const providerRun = await registerConfiguredProviders({
      config: loaded.config,
      paths: loaded.paths,
    });
    for (const warning of providerRun.warnings) err(`arcturn: ${warning}\n`);
    for (const line of configLines(loaded.config, loaded.sources, env)) out(`${line}\n`);

    const refs = collectConfigRefs(loaded.config);
    const configTargets = [...refs].map(([id, labels]) => configTarget(id, labels, env));
    const covered = new Set(
      configTargets
        .map((target) => target.preset)
        .filter((name): name is string => name !== undefined),
    );
    const scan = await scanTargets(env, covered, options);
    targets = [...configTargets, ...scan.targets];
    trailer = scan.trailer;
  }

  if (targets.length === 0) {
    out("Nothing to probe: no provider key is set and the config references no endpoint.\n");
    return 0;
  }

  // `retry: false` is load-bearing: the retry layer honors retry-after up to
  // 60s across four attempts, so one broken preset would hold the report for
  // minutes — the exact wait this command exists to skip.
  const client =
    options.client ??
    createClient({ env, retry: false, requestStallTimeoutMs: PROBE_STALL_TIMEOUT_MS });
  const deadlineMs = options.timeoutMs ?? DEFAULT_PROBE_DEADLINE_MS;

  const rows = await mapPool(targets, PROBE_POOL_SIZE, async (target): Promise<ProbeRow> => {
    if (target.pre !== undefined || target.spec === undefined) {
      const pre = target.pre ?? {
        word: "error",
        detail: "nothing to probe for this entry",
        failed: true,
      };
      return { name: target.name, verdict: decorate(pre, target, env) };
    }
    const outcome = await probe(client, target.spec, deadlineMs);
    const verdict =
      outcome.error === undefined
        ? okVerdict(target.spec, outcome)
        : classify(outcome.error, target, env);
    return { name: target.name, verdict: decorate(verdict, target, env) };
  });

  renderRows(rows, out);
  for (const line of trailer) out(`${line}\n`);

  const failed = rows.filter((row) => row.verdict.failed).length;
  out(
    `\n${failed === 0 ? `All ${rows.length} checks passed.` : `${failed} of ${rows.length} checks failed.`}\n`,
  );
  return failed > 0 ? 1 : 0;
}

/** Render the aligned report table, `formatProviderCatalog` style. */
function renderRows(rows: ProbeRow[], out: (text: string) => void): void {
  const nameWidth = rows.reduce((max, row) => Math.max(max, row.name.length), 0);
  const wordWidth = rows.reduce((max, row) => Math.max(max, row.verdict.word.length), 0);
  out("Endpoint probes:\n\n");
  for (const row of rows) {
    out(
      `  ${row.name.padEnd(nameWidth)}  ${row.verdict.word.padEnd(wordWidth)}  ${row.verdict.detail}\n`,
    );
    if (row.verdict.hint !== undefined) {
      out(`  ${" ".repeat(nameWidth)}  ${row.verdict.hint}\n`);
    }
  }
}

/**
 * The config section: what a session started right now would talk to, and the
 * mismatches that make the answer surprising.
 */
function configLines(config: ArcturnConfig, sources: string[], env: EnvMap): string[] {
  const chain = Array.isArray(config.model) ? config.model : [config.model];
  const head = chain[0];
  const entries: [string, string][] = [];
  entries.push([
    "sources",
    sources.length > 0 ? sources.join(" → ") : "built-in defaults (no config file found)",
  ]);
  // `route.main` outvotes `model` wherever a route is resolved, so the honest
  // "your session would use" answer is main-first — see the split-brain
  // warning below when the two disagree.
  entries.push(["session model", config.route?.main ?? head ?? "(none)"]);
  entries.push([
    "model",
    chain.join(" → ") + (chain.length > 1 ? "   (failover chain — every link is probed)" : ""),
  ]);
  for (const kind of ROUTE_KINDS) {
    const id = config.route?.[kind];
    if (id !== undefined) entries.push([`route.${kind}`, id]);
  }
  for (const [tier, id] of Object.entries(config.route?.tiers ?? {})) {
    entries.push([`route.tiers.${tier}`, id]);
  }
  if (config.consensus !== undefined) {
    entries.push(["consensus", config.consensus.models.join(", ")]);
  }
  // Declared endpoints, with their state. A provider nobody has enabled is
  // invisible in the probe table unless some id references it, and "I added
  // it and nothing happened" is exactly the question doctor exists to answer.
  for (const status of configuredProviderStatuses()) {
    entries.push([
      `providers.${status.name}`,
      `${status.baseUrl} · ${status.apiKeyEnv === undefined ? "no credential" : `key ${status.apiKeyEnv}`} · ` +
        `${status.enabled ? "enabled" : `declared (not enabled) — ${status.reason ?? ""}`}`.trim(),
    ]);
  }

  const width = entries.reduce((max, [key]) => Math.max(max, key.length), 0);
  const lines = ["Config:", ...entries.map(([key, value]) => `  ${key.padEnd(width)}  ${value}`)];
  if (env.ARCTURN_MODEL) {
    lines.push(`  note: ARCTURN_MODEL is set — it replaces every config file's "model" wholesale`);
  }
  if (config.route?.main !== undefined && head !== undefined && config.route.main !== head) {
    lines.push(
      `  warning: route.main (${config.route.main}) is not the head of "model" (${head}) — ` +
        "the chat obeys route.main",
    );
  }
  lines.push("");
  return lines;
}

/** Every model id the config references, mapped to the keys that name it. */
function collectConfigRefs(config: ArcturnConfig): Map<string, string[]> {
  const refs = new Map<string, string[]>();
  const add = (id: string | undefined, label: string) => {
    if (id === undefined) return;
    refs.set(id, [...(refs.get(id) ?? []), label]);
  };
  const chain = Array.isArray(config.model) ? config.model : [config.model];
  for (const [index, id] of chain.entries()) {
    add(id, chain.length > 1 ? `model[${index}]` : "model");
  }
  for (const kind of ROUTE_KINDS) add(config.route?.[kind], `route.${kind}`);
  for (const [tier, id] of Object.entries(config.route?.tiers ?? {})) {
    add(id, `route.tiers.${tier}`);
  }
  for (const id of config.consensus?.models ?? []) add(id, "consensus");
  return refs;
}

/** Build the target for one config-referenced model id. */
function configTarget(id: string, labels: string[], env: EnvMap): ProbeTarget {
  // Asked BEFORE the catalog lookup, and answered without a network
  // round-trip. An endpoint a project config declared but nobody consented to
  // is not a broken configuration to diagnose — it is a configuration that is
  // deliberately switched off, and the one thing doctor must not do is send a
  // key to it to find out.
  const declared = declaredProvider(id);
  if (declared !== undefined) {
    return {
      name: id,
      labels,
      pre: {
        word: "not enabled",
        detail:
          `provider "${declared.name}" is declared in ${declared.source} ` +
          `(${declared.baseUrl}) but not enabled — nothing was sent`,
        hint: "approve it in an interactive arcturn session, or declare it in ~/.arcturn/config.json",
        failed: false,
      },
    };
  }
  const spec = resolveConfigSpec(id);
  if (spec === undefined) {
    return {
      name: id,
      labels,
      pre: {
        word: "unknown model",
        detail: "not in the catalog — check the id (arcturn --list-models)",
        failed: true,
      },
    };
  }
  const preset = presetOf(spec.id);
  const base: ProbeTarget = { name: id, labels, ...(preset === undefined ? {} : { preset }) };
  if (spec.baseUrl?.includes("{") === true) {
    return { ...base, pre: placeholderVerdict(spec.baseUrl) };
  }
  if (resolveApiKey(spec, { env }) === undefined) {
    if (spec.baseUrl !== undefined && isLocalEndpoint(spec.baseUrl)) {
      return { ...base, spec: withoutApiKeyEnv(spec) };
    }
    if (spec.apiKeyEnv !== undefined) {
      // Mirrors resolveModelSpec's refusal: a session on this id would not
      // start, so the row is a failure even though nothing was sent.
      return {
        ...base,
        pre: { word: "no key", detail: `set ${spec.apiKeyEnv}`, failed: true },
      };
    }
    // No variable named at all: ambient credentials (Bedrock, Vertex) this
    // process cannot inspect. Probe, and let the endpoint judge.
  }
  return { ...base, spec };
}

/**
 * Resolve a config-referenced id the way a session would, plus one fallback a
 * session lacks: `<preset>/<model>` with an uncurated model id is still a
 * probeable endpoint, because preset model ids pass through to the wire
 * verbatim.
 */
function resolveConfigSpec(id: string): ModelSpec | undefined {
  const direct = getModel(id);
  if (direct !== undefined) return direct;
  // Same pass-through rule for an ENABLED config-declared provider that
  // curates no `models` list. Returns undefined for a declared-but-not-enabled
  // one, which `configTarget` has already caught above.
  const configured = configuredProviderSpec(id);
  if (configured !== undefined) return configured;
  const slash = id.indexOf("/");
  if (slash > 0) {
    const preset = id.slice(0, slash);
    const model = id.slice(slash + 1);
    if (PROVIDER_PRESETS[preset] !== undefined && model.length > 0) {
      return presetSpec(preset, model);
    }
  }
  return undefined;
}

/** Targets from the preset table: every preset whose own key variable is set. */
async function scanTargets(
  env: EnvMap,
  covered: ReadonlySet<string>,
  options: RunDoctorCommandOptions,
): Promise<{ targets: ProbeTarget[]; trailer: string[] }> {
  const eligible: string[] = [];
  const local: string[] = [];
  let skipped = 0;
  const names = Object.keys(PROVIDER_PRESETS).sort();
  for (const name of names) {
    const entry = PROVIDER_PRESETS[name];
    if (entry === undefined) continue;
    // The scan keys on the preset's *own* variable, like --list-providers.
    // resolveApiKey would also accept the provider-default fallback
    // (OPENAI_API_KEY), but that would spray one vendor's key at thirty
    // unrelated hosts; the fallback fact is still reported per-row when a
    // config-referenced model actually rides it.
    if (!env[entry.apiKeyEnv]) {
      if (isLocalEndpoint(entry.baseUrl)) local.push(name);
      else skipped++;
      continue;
    }
    // A config-referenced model already exercises this endpoint and key; a
    // second probe of the curated head would say nothing new.
    if (covered.has(name)) continue;
    eligible.push(name);
  }
  // Target construction can itself hit the network — an uncurated keyed
  // preset asks its endpoint for a model list, up to the probe deadline each.
  // Awaiting them one by one serialized those waits before a single probe
  // started; build under the same small pool the probes use instead. mapPool
  // keeps result order, so the report stays deterministic (sorted by name).
  const targets = await mapPool(eligible, PROBE_POOL_SIZE, (name) =>
    presetTarget(name, env, options),
  );
  const trailer: string[] = [];
  if (skipped > 0 || local.length > 0) trailer.push("");
  if (skipped > 0) {
    trailer.push(
      `Skipped ${skipped} preset${skipped === 1 ? "" : "s"} with no key set ` +
        "(arcturn --list-providers names each variable).",
    );
  }
  if (local.length > 0) {
    trailer.push(
      `Local presets (${local.join(", ")}) are probed only when named: arcturn doctor <preset>.`,
    );
  }
  return { targets, trailer };
}

/** Build the target for one named preset (the scan, or `doctor <preset>`). */
async function presetTarget(
  name: string,
  env: EnvMap,
  options: RunDoctorCommandOptions,
): Promise<ProbeTarget> {
  const entry = PROVIDER_PRESETS[name];
  const base: ProbeTarget = { name, preset: name, labels: [] };
  if (entry === undefined) {
    return { ...base, pre: { word: "error", detail: "unknown preset", failed: true } };
  }
  if (entry.baseUrl.includes("{")) {
    return { ...base, pre: placeholderVerdict(entry.baseUrl) };
  }
  // The key question comes BEFORE the model question. For an uncurated preset
  // the model id has to come from discovery, and discovery itself needs the
  // key — so asking model-first turned a keyless `doctor openrouter` into a
  // non-failing "no known model" row and exit 0, masking the real diagnosis.
  // Only a keyed endpoint (or a keyless local runtime) may proceed to the
  // model pick; only those earn the softer "no known model" verdict. The
  // throwaway spec exists purely so resolveApiKey can walk its fallback
  // chain — key resolution never reads the model id and nothing is sent.
  const keyed = resolveApiKey(presetSpec(name, "key-check"), { env }) !== undefined;
  if (!keyed && !isLocalEndpoint(entry.baseUrl)) {
    return {
      ...base,
      pre: {
        word: "no key",
        detail: `set ${entry.apiKeyEnv} to probe ${entry.label}`,
        failed: true,
      },
    };
  }
  const model = options.model ?? (await pickModel(name, env, options));
  if (model === undefined) {
    return {
      ...base,
      pre: {
        word: "no known model",
        detail: `no model id known for this preset — pass one: arcturn doctor ${name} --model <id>`,
        failed: false,
      },
    };
  }
  const spec = presetSpec(name, model);
  if (!keyed) {
    // Genuinely keyless local runtimes probe fine; stripping the variable
    // is what tells the adapter precheck this is that case.
    return { ...base, spec: withoutApiKeyEnv(spec) };
  }
  return { ...base, spec };
}

/**
 * Build the target for one named base provider (`doctor openai`, `doctor
 * anthropic`, `doctor google`) — the same report row shape {@link
 * presetTarget} builds for a preset, but sourced from the curated catalog
 * rather than `PROVIDER_PRESETS`, since these providers are not presets.
 */
async function providerTarget(
  name: string,
  env: EnvMap,
  options: RunDoctorCommandOptions,
): Promise<ProbeTarget> {
  const base: ProbeTarget = { name, labels: [] };
  const model = options.model ?? (await pickModel(name, env, options));
  if (model === undefined) {
    return {
      ...base,
      pre: {
        word: "no known model",
        detail: `no model id known for this provider — pass one: arcturn doctor ${name} --model <id>`,
        failed: false,
      },
    };
  }
  // `model` came from the same catalog lookup as the id below (or from
  // `--model`, an explicit override this provider's adapter accepts
  // regardless of curation), so this is never undefined in practice; the
  // fallback keeps the type honest without inventing a spec that could send
  // a request nobody asked for.
  const spec = getModel(`${name}/${model}`) ?? {
    id: `${name}/${model}`,
    provider: name as ModelSpec["provider"],
    model,
    displayName: model,
    contextWindow: 0,
    maxOutputTokens: 0,
    capabilities: { tools: false, vision: false, thinking: false, caching: false },
    apiKeyEnv: DEFAULT_API_KEY_ENV[name],
  };
  const keyed = resolveApiKey(spec, { env }) !== undefined;
  if (!keyed) {
    const apiKeyEnv =
      spec.apiKeyEnv ?? DEFAULT_API_KEY_ENV[name] ?? `${name.toUpperCase()}_API_KEY`;
    return {
      ...base,
      pre: { word: "no key", detail: `set ${apiKeyEnv} to probe ${name}`, failed: true },
    };
  }
  return { ...base, spec };
}

/**
 * The model id a preset probe speaks: the curated head when the preset has
 * curated models (the first registered entry, i.e. the top of its table), the
 * endpoint's own model listing otherwise. Discovery needing the preset's own
 * env var or failing outright is a "don't know", not an error — the caller
 * turns `undefined` into a "no known model" row.
 */
async function pickModel(
  name: string,
  env: EnvMap,
  options: RunDoctorCommandOptions,
): Promise<string | undefined> {
  const head = listModels().find((spec) => spec.id.startsWith(`${name}/`));
  if (head !== undefined) return head.model;
  try {
    const discovered = await discoverModels(name, {
      env,
      ...(options.fetchFn === undefined ? {} : { fetchFn: options.fetchFn }),
      timeoutMs: options.timeoutMs ?? DEFAULT_PROBE_DEADLINE_MS,
    });
    return discovered[0]?.id;
  } catch {
    return undefined;
  }
}

/** Send the minimal one-token completion and watch what comes back. */
async function probe(
  client: LLMClient,
  spec: ModelSpec,
  deadlineMs: number,
): Promise<ProbeOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  const started = Date.now();
  let error: AIError | undefined;
  let outputTokens: number | undefined;
  try {
    // stream(), not complete(): assembly flattens the typed AIError into a
    // flat errorMessage string, and the verdict below needs the `kind`.
    const stream = client.stream({
      model: spec,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: Date.now() }],
      maxOutputTokens: 1,
      signal: controller.signal,
    });
    for await (const event of stream) {
      if (event.type === "error") error = event.error;
      else if (event.type === "usage") outputTokens = event.usage.outputTokens;
    }
  } catch (thrown) {
    // The client contract ends streams with an `error` event, never a throw;
    // an injected client may not honor that, and a throw must still verdict.
    error = {
      kind: "unknown",
      message: thrown instanceof Error ? thrown.message : String(thrown),
    };
  } finally {
    clearTimeout(timer);
  }
  return {
    ...(error === undefined ? {} : { error }),
    latencyMs: Date.now() - started,
    ...(outputTokens === undefined ? {} : { outputTokens }),
  };
}

/** The verdict for a probe that came back clean. */
function okVerdict(spec: ModelSpec, outcome: ProbeOutcome): Verdict {
  const parts = [`${outcome.latencyMs} ms`];
  if (outcome.outputTokens !== undefined) {
    parts.push(`${outcome.outputTokens} token${outcome.outputTokens === 1 ? "" : "s"} out`);
  }
  const plan = subscriptionPlanFor(spec.id);
  // A subscription endpoint has no per-token rate; "$0.00" would read as
  // free, so the honest phrasing is the plan's name and an admitted unknown.
  if (plan !== undefined) parts.push(`covered by plan (${plan}); pricing unknown`);
  return { word: "ok", detail: parts.join(" · "), failed: false };
}

/**
 * Turn a typed provider error into a verdict. Doctor-local on purpose: the
 * `AIError.kind` union is load-bearing across the protocol and workflows, so
 * finer distinctions like "no balance" live here, not in a new kind.
 */
function classify(error: AIError, target: ProbeTarget, env: EnvMap): Verdict {
  const status = error.status === undefined ? "" : `${error.status}: `;
  if (error.kind === "auth") {
    const keyVar =
      target.spec === undefined
        ? undefined
        : (keySourceVar(target.spec, env) ?? target.spec.apiKeyEnv);
    return {
      word: "auth failed",
      detail: `${status}${error.message}${keyVar === undefined ? "" : ` — check ${keyVar}`}`,
      failed: true,
    };
  }
  if (error.kind === "rateLimit" && NO_BALANCE_PATTERN.test(error.message)) {
    const variants = PROVIDER_PRESETS[target.preset ?? ""]?.regionalVariants;
    return {
      word: "no balance",
      detail: `${status}${error.message}`,
      ...(variants !== undefined && variants.length > 0
        ? {
            hint: `your key may belong to a sibling endpoint — try preset ${variants.join(" or ")}`,
          }
        : {}),
      failed: true,
    };
  }
  if (error.kind === "rateLimit") {
    const retry =
      error.retryAfterMs === undefined
        ? ""
        : ` — retry in ${Math.ceil(error.retryAfterMs / 1000)}s`;
    return { word: "rate limited", detail: `${status}${error.message}${retry}`, failed: true };
  }
  if (error.kind === "network") {
    return { word: "network", detail: error.message, failed: true };
  }
  if (error.kind === "invalidRequest" && UNKNOWN_MODEL_PATTERN.test(error.message)) {
    return { word: "unknown model", detail: `${status}${error.message}`, failed: true };
  }
  if (error.kind === "aborted") {
    return { word: "timed out", detail: "no verdict before the probe deadline", failed: true };
  }
  return { word: "error", detail: `${status}${error.message}`, failed: true };
}

/** Append the model id, key facts and config labels to a row's detail. */
function decorate(verdict: Verdict, target: ProbeTarget, env: EnvMap): Verdict {
  const extras: string[] = [];
  if (target.spec !== undefined && target.spec.id !== target.name) extras.push(target.spec.id);
  const key = keyFacts(target.spec, env);
  if (key !== undefined) extras.push(key);
  if (target.labels.length > 0) extras.push(`for: ${target.labels.join(", ")}`);
  if (extras.length === 0) return verdict;
  const detail =
    verdict.detail === "" ? extras.join(" · ") : `${verdict.detail} · ${extras.join(" · ")}`;
  return { ...verdict, detail };
}

/**
 * Both key facts the report owes per endpoint: whether the spec's own
 * variable is set, and — when it is not — which variable actually supplied
 * the key that went on the wire. The second fact is the classic confusing
 * 401: a preset with its own var unset silently borrows OPENAI_API_KEY and
 * sends it to the wrong host.
 */
function keyFacts(spec: ModelSpec | undefined, env: EnvMap): string | undefined {
  if (spec?.apiKeyEnv === undefined) return undefined;
  if (env[spec.apiKeyEnv]) return `key ${spec.apiKeyEnv} ✓`;
  const source = keySourceVar(spec, env);
  if (source !== undefined && source !== spec.apiKeyEnv) {
    return `key ${spec.apiKeyEnv} ✗ — sent the key from ${source}`;
  }
  return `key ${spec.apiKeyEnv} ✗`;
}

/**
 * The variable that supplies `spec`'s key, walking the same precedence
 * `resolveApiKey` does (own variable, provider default, provider fallbacks).
 * `resolveApiKey` returns only the value; this report needs the *name*.
 *
 * A key-exclusive spec — every endpoint declared in a `providers` config block
 * — has no precedence to walk: its own variable is the whole chain, so an unset
 * one supplies nothing. Reporting "sent the key from OPENAI_API_KEY" for one of
 * those would describe a borrow that no longer happens.
 */
function keySourceVar(spec: ModelSpec, env: EnvMap): string | undefined {
  if (spec.apiKeyEnvExclusive === true) {
    return spec.apiKeyEnv !== undefined && env[spec.apiKeyEnv] ? spec.apiKeyEnv : undefined;
  }
  const providerDefault = DEFAULT_API_KEY_ENV[spec.provider];
  const names = [
    ...(spec.apiKeyEnv === undefined ? [] : [spec.apiKeyEnv]),
    ...(providerDefault === undefined ? [] : [providerDefault]),
    ...(FALLBACK_API_KEY_ENV[spec.provider] ?? []),
  ];
  return names.find((name) => Boolean(env[name]));
}

/** Verdict for the Cloudflare-style base URLs that still carry placeholders. */
function placeholderVerdict(baseUrl: string): Verdict {
  return {
    word: "needs substitution",
    detail: `base URL still contains a placeholder (${baseUrl}) — fill in your ids before this endpoint is probeable`,
    failed: false,
  };
}

/** The preset a catalog id belongs to, when its prefix names one. */
function presetOf(id: string): string | undefined {
  const prefix = id.split("/")[0] ?? "";
  return PROVIDER_PRESETS[prefix] === undefined ? undefined : prefix;
}

/**
 * A copy of `spec` with no key variable: the adapter prechecks read an
 * `apiKeyEnv` as "expects a key" and refuse without one, while a spec naming
 * none is the documented keyless-local case and passes.
 */
function withoutApiKeyEnv(spec: ModelSpec): ModelSpec {
  const { apiKeyEnv: _dropped, ...keyless } = spec;
  return keyless;
}

/** Run `worker` over `items` with at most `limit` in flight, keeping order. */
async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) continue;
      results[index] = await worker(item);
    }
  });
  await Promise.all(lanes);
  return results;
}
