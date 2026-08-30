/**
 * Provider dispatch: one {@link LLMClient} that routes each request to the
 * adapter named by `request.model.provider`.
 */

import type { LLMClient, LLMRequest, ModelSpec, ProviderId, StreamEvent } from "@arcturn/types";
import { DEFAULT_API_KEY_ENV, FALLBACK_API_KEY_ENV } from "./catalog.js";
import { AIErrorException, toAIError } from "./errors.js";
import { withIdleTimeout } from "./idle-timeout.js";
import { completeFromStream, MessageAssembler } from "./internal/stream.js";
import { registerBuiltinProviders } from "./providers/builtins.js";
import {
  getProviderFactory,
  listProviderIds,
  type ProviderFactoryContext,
} from "./providers/registry.js";
import { type RetryOptions, withRetry } from "./retry.js";
import { downgradeImages } from "./vision.js";

registerBuiltinProviders();

/** A read-only environment map, defaulting to `process.env`. */
export type EnvSource = Record<string, string | undefined>;

/** Options for {@link createClient}. */
export interface CreateClientOptions {
  /** Explicit API key, used for every provider unless overridden per provider. */
  apiKey?: string;
  /** Per-provider API keys, keyed by {@link ProviderId}. */
  apiKeys?: Record<string, string | undefined>;
  /** Override the base URL for every request (ignored when the spec sets one). */
  baseUrl?: string;
  /** Extra HTTP headers merged into every provider request. */
  headers?: Record<string, string>;
  /** Environment used to resolve API keys. Defaults to `process.env`. */
  env?: EnvSource;
  /** Retry policy; pass `false` to disable retries entirely. */
  retry?: RetryOptions | false;
  /**
   * Idle-stall watchdog: abort and surface a transient `network` error when a
   * streaming response emits no event for this many milliseconds (a dead socket,
   * not a slow one). Absent uses {@link DEFAULT_REQUEST_STALL_TIMEOUT_MS}; `0`
   * disables it. Not a total-duration cap — a long, actively streaming turn is
   * never interrupted. The resulting error rides the normal retry/failover path.
   */
  requestStallTimeoutMs?: number;
  /** Replace an adapter wholesale, e.g. for tests or a bespoke provider. */
  providers?: Record<string, LLMClient>;
  /**
   * Supplies bearer tokens for providers authenticated by OAuth rather than an
   * API key, refreshing them as needed. Wire this to an OAuth token store.
   */
  getAccessToken?: (provider: ProviderId) => Promise<string>;
}

function processEnv(): EnvSource {
  const globalProcess = (globalThis as { process?: { env?: EnvSource } }).process;
  return globalProcess?.env ?? {};
}

/**
 * Resolve the API key for a model.
 *
 * Precedence: explicit per-provider key, explicit shared key,
 * `spec.apiKeyEnv`, the provider's default env var, then provider fallbacks.
 *
 * Unless the spec sets {@link ModelSpec.apiKeyEnvExclusive}, in which case
 * there is no precedence at all: `spec.apiKeyEnv` is consulted and nothing
 * else. That is the contract a configuration-declared endpoint is registered
 * under — the file named one variable, so one variable is what it gets, and an
 * unset one resolves to `undefined` rather than to the user's first-party key.
 * The two explicit options are skipped too: a shared `apiKey`, or an `apiKeys`
 * entry keyed on `openai-compatible`, spans every endpoint speaking that
 * protocol and was never chosen for this one.
 */
export function resolveApiKey(
  spec: ModelSpec,
  options: CreateClientOptions = {},
): string | undefined {
  const env = options.env ?? processEnv();
  if (spec.apiKeyEnvExclusive === true) {
    if (spec.apiKeyEnv === undefined) return undefined;
    // Empty counts as unset, exactly as the fallback loop below reads it.
    return env[spec.apiKeyEnv] || undefined;
  }
  const perProvider = options.apiKeys?.[spec.provider];
  if (perProvider) return perProvider;
  if (options.apiKey) return options.apiKey;

  const names: string[] = [];
  if (spec.apiKeyEnv) names.push(spec.apiKeyEnv);
  const fallback = DEFAULT_API_KEY_ENV[spec.provider];
  if (fallback) names.push(fallback);
  names.push(...(FALLBACK_API_KEY_ENV[spec.provider] ?? []));

  for (const name of names) {
    const value = env[name];
    if (value) return value;
  }
  return undefined;
}

function buildProvider(ctx: ProviderFactoryContext): LLMClient {
  const registration = getProviderFactory(ctx.spec.provider);
  if (!registration) {
    throw new AIErrorException({
      kind: "invalidRequest",
      message:
        `Unsupported provider: ${ctx.spec.provider}. ` +
        `Registered providers: ${listProviderIds().join(", ")}.`,
    });
  }
  const failure = registration.checkCredentials?.(ctx);
  if (failure) throw new AIErrorException(failure);
  return registration.factory(ctx);
}

/**
 * Create the unified multi-provider client.
 *
 * Adapters are constructed lazily and cached per provider/base URL/key triple,
 * so a long-lived client reuses connections across requests.
 */
export function createClient(options: CreateClientOptions = {}): LLMClient {
  const cache = new Map<string, LLMClient>();

  const resolve = (spec: ModelSpec): LLMClient => {
    const override = options.providers?.[spec.provider];
    if (override) return override;

    const registration = getProviderFactory(spec.provider);
    const baseUrl = spec.baseUrl ?? options.baseUrl;
    const apiKey = resolveApiKey(spec, options);
    const extra = registration?.cacheKeyOf?.(spec) ?? "";
    const cacheKey = `${spec.provider} ${baseUrl ?? ""} ${apiKey ?? ""} ${extra}`;
    const existing = cache.get(cacheKey);
    if (existing) return existing;

    const created = buildProvider({
      spec,
      apiKey,
      baseUrl,
      headers: options.headers,
      ...(options.getAccessToken ? { getAccessToken: options.getAccessToken } : {}),
    });
    cache.set(cacheKey, created);
    return created;
  };

  // Dispatch failures (missing key, unknown provider) must surface as a normal
  // terminal `error` event rather than a thrown exception.
  async function* dispatch(input: LLMRequest): AsyncIterable<StreamEvent> {
    // A model without vision cannot be sent image blocks: the provider
    // rejects the whole call rather than the one part it cannot read.
    const request = downgradeImages(input);
    let provider: LLMClient;
    try {
      provider = resolve(request.model);
    } catch (err) {
      const error = toAIError(err, request.signal);
      yield { type: "start", model: request.model.id };
      yield {
        type: "error",
        error,
        message: new MessageAssembler(request.model).finalize("error", error.message),
      };
      return;
    }
    yield* provider.stream(request);
  }

  const base: LLMClient = {
    stream(request: LLMRequest): AsyncIterable<StreamEvent> {
      return dispatch(request);
    },
    complete(request: LLMRequest) {
      return completeFromStream(this.stream(request));
    },
  };

  // The idle watchdog sits closest to the provider (inside retry/failover) so
  // each attempt gets its own fresh timer and a stall is retried/failed-over
  // like any transient network error.
  const guarded = withIdleTimeout(base, { timeoutMs: options.requestStallTimeoutMs });

  if (options.retry === false) return guarded;
  return withRetry(guarded, options.retry ?? {});
}
