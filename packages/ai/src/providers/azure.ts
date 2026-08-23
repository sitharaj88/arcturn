/**
 * Azure OpenAI adapter.
 *
 * Azure serves the OpenAI Chat Completions dialect, so this adapter owns only
 * the things Azure does differently — endpoint/deployment/api-version routing
 * and Entra ID auth — and delegates message conversion, tool-call accumulation
 * and stream assembly to `openai.ts` so behaviour matches exactly.
 *
 * The single semantic difference worth remembering: Azure addresses a
 * *deployment name*, not a model name. `spec.model` is treated as the
 * deployment unless `providerOptions.deployment` says otherwise.
 */

import type {
  LLMClient,
  LLMRequest,
  ModelCapabilities,
  ModelSpec,
  StreamEvent,
} from "@arcturn/types";
import { registerModel } from "../catalog.js";
import { AIErrorException } from "../errors.js";
import {
  assembleStream,
  completeFromStream,
  type ProviderStreamEvent,
} from "../internal/stream.js";
import { type OpenAIClientLike, openaiEventStream, supportsTemperature } from "./openai.js";
import type { ProviderFactoryContext, ProviderPrecheckFailure } from "./registry.js";

/** Cached SDK module promise; see {@link loadAzureSdk}. */
let azureSdk: Promise<typeof import("openai/azure")> | undefined;

/** Loads the SDK on first use so importing this module stays cheap at CLI startup. */
function loadAzureSdk(): Promise<typeof import("openai/azure")> {
  azureSdk ??= import("openai/azure");
  return azureSdk;
}

/**
 * API version used when none is configured.
 *
 * Azure pins its surface per version; this is the GA version that supports
 * streaming tool calls. Reasoning deployments (o-series, GPT-5) may need a
 * newer preview version — set `AZURE_OPENAI_API_VERSION` or
 * `providerOptions.apiVersion`.
 */
export const AZURE_DEFAULT_API_VERSION = "2024-10-21";

/** Environment variable naming the Azure OpenAI resource endpoint. */
export const AZURE_ENDPOINT_ENV = "AZURE_OPENAI_ENDPOINT";

/** Environment variable holding the Azure OpenAI API key. */
export const AZURE_API_KEY_ENV = "AZURE_OPENAI_API_KEY";

/** Environment variables consulted for the API version, in order. */
export const AZURE_API_VERSION_ENV: readonly string[] = [
  "AZURE_OPENAI_API_VERSION",
  "OPENAI_API_VERSION",
];

/** A read-only environment map, defaulting to `process.env`. */
export type AzureEnv = Record<string, string | undefined>;

/**
 * Azure routing carried on a {@link ModelSpec}.
 *
 * Carried in `ModelSpec.providerOptions`, which addresses the service rather
 * than the request: these values select and cache the adapter, and are never
 * spread onto the wire payload.
 */
export type AzureSpecOptions = {
  /** Resource endpoint, e.g. `"https://my-resource.openai.azure.com"`. */
  endpoint?: string;
  /** Deployment name; defaults to `spec.model`. */
  deployment?: string;
  /** Azure API version, e.g. `"2024-10-21"`. */
  apiVersion?: string;
};

/** A {@link ModelSpec} carrying {@link AzureSpecOptions}. */
export type AzureModelSpec = ModelSpec & { providerOptions?: AzureSpecOptions };

/** Construction options for {@link createAzureProvider}. */
export interface AzureProviderOptions {
  /** API key; ignored when {@link AzureProviderOptions.azureADTokenProvider} is set. */
  apiKey?: string;
  /** Resource endpoint; overridden by the spec's `providerOptions.endpoint`. */
  endpoint?: string;
  /** Deployment name; overridden by the spec's `providerOptions.deployment`. */
  deployment?: string;
  /** API version; overridden by the spec's `providerOptions.apiVersion`. */
  apiVersion?: string;
  /** Extra headers merged into every request. */
  headers?: Record<string, string>;
  /**
   * Returns a Microsoft Entra ID access token, called once per request. Azure
   * rejects a key and a token together, so this wins when both are supplied.
   */
  azureADTokenProvider?: () => Promise<string>;
  /** Send `stream_options.include_usage`; disable for gateways that reject it. */
  includeUsage?: boolean;
  /** Environment used to resolve endpoint, key and version. Defaults to `process.env`. */
  env?: AzureEnv;
  /** Pre-built client; primarily an injection seam for tests. */
  client?: OpenAIClientLike;
}

/** Fully resolved Azure routing for one model. */
export interface AzureConfig {
  endpoint: string | undefined;
  /** The name Azure actually addresses — never the catalog model id. */
  deployment: string;
  apiVersion: string;
}

function processEnv(): AzureEnv {
  const globalProcess = (globalThis as { process?: { env?: AzureEnv } }).process;
  return globalProcess?.env ?? {};
}

function firstEnv(env: AzureEnv, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value) return value;
  }
  return undefined;
}

function specOptions(spec: ModelSpec): AzureSpecOptions {
  const raw = (spec as AzureModelSpec).providerOptions;
  return raw && typeof raw === "object" ? raw : {};
}

/**
 * Resolve endpoint, deployment and API version for one model.
 *
 * Precedence is spec `providerOptions`, then the provider options, then
 * `spec.baseUrl` (read as the resource endpoint), then the environment.
 */
export function resolveAzureConfig(
  spec: ModelSpec,
  options: AzureProviderOptions = {},
): AzureConfig {
  const fromSpec = specOptions(spec);
  const env = options.env ?? processEnv();
  return {
    endpoint: fromSpec.endpoint ?? options.endpoint ?? spec.baseUrl ?? env[AZURE_ENDPOINT_ENV],
    deployment: fromSpec.deployment ?? options.deployment ?? spec.model,
    apiVersion:
      fromSpec.apiVersion ??
      options.apiVersion ??
      firstEnv(env, AZURE_API_VERSION_ENV) ??
      AZURE_DEFAULT_API_VERSION,
  };
}

/**
 * Cache key contribution for the provider registry.
 *
 * An Azure client is bound to one endpoint, deployment and API version, so all
 * three belong in the key.
 */
export function azureCacheKey(spec: ModelSpec, options: AzureProviderOptions = {}): string {
  const config = resolveAzureConfig(spec, options);
  return `azure:${config.endpoint ?? ""}:${config.deployment}:${config.apiVersion}`;
}

/**
 * Pre-dispatch check: an endpoint is mandatory, and so is either an API key or
 * a token provider.
 */
export function checkAzureCredentials(
  ctx: ProviderFactoryContext,
  options: AzureProviderOptions = {},
): ProviderPrecheckFailure | undefined {
  const env = options.env ?? processEnv();
  if (!resolveAzureConfig(ctx.spec, options).endpoint) {
    return {
      kind: "invalidRequest",
      message:
        `No Azure OpenAI endpoint for ${ctx.spec.id}; set ${AZURE_ENDPOINT_ENV} or ` +
        "providerOptions.endpoint on the model spec",
    };
  }
  if (ctx.apiKey || options.apiKey || env[AZURE_API_KEY_ENV]) return undefined;
  if (options.azureADTokenProvider || ctx.getAccessToken) return undefined;
  return {
    kind: "auth",
    message: `No Azure OpenAI credential for ${ctx.spec.id}; set ${AZURE_API_KEY_ENV} or configure Entra ID`,
  };
}

/**
 * Rewrite a request so the wire payload names the deployment.
 *
 * The spec is also relabelled as `openai` so `buildOpenAIRequest` picks the
 * first-party dialect (`max_completion_tokens`, `reasoning_effort`), which is
 * what Azure serves. Temperature support is judged from the catalog model name
 * as well, since a deployment may be named anything at all.
 */
export function azureStreamRequest(request: LLMRequest, deployment: string): LLMRequest {
  const spec = request.model;
  const wire: ModelSpec = { ...spec, provider: "openai", model: deployment };
  const next: LLMRequest = { ...request, model: wire };
  if (next.temperature !== undefined && !supportsTemperature({ ...spec, provider: "openai" })) {
    delete next.temperature;
  }
  return next;
}

function createAzureClient(
  config: AzureConfig,
  options: AzureProviderOptions,
): Promise<OpenAIClientLike> {
  const endpoint = config.endpoint;
  if (!endpoint) {
    throw new AIErrorException({
      kind: "invalidRequest",
      message: `No Azure OpenAI endpoint for deployment ${config.deployment}; set ${AZURE_ENDPOINT_ENV}`,
    });
  }
  const env = options.env ?? processEnv();
  const tokenProvider = options.azureADTokenProvider;
  const apiKey = options.apiKey ?? env[AZURE_API_KEY_ENV];
  if (!tokenProvider && !apiKey) {
    throw new AIErrorException({
      kind: "auth",
      message: `No Azure OpenAI credential; set ${AZURE_API_KEY_ENV} or pass azureADTokenProvider`,
    });
  }
  return loadAzureSdk().then(
    ({ AzureOpenAI }) =>
      new AzureOpenAI({
        endpoint,
        apiVersion: config.apiVersion,
        deployment: config.deployment,
        // The SDK rejects a key and a token provider together.
        ...(tokenProvider ? { azureADTokenProvider: tokenProvider } : { apiKey }),
        ...(options.headers ? { defaultHeaders: options.headers } : {}),
        // Retries are handled by streamWithRetry, which honours AbortSignal.
        maxRetries: 0,
      }) as unknown as OpenAIClientLike,
  );
}

/**
 * Create an {@link LLMClient} backed by Azure OpenAI.
 *
 * One provider instance serves every deployment on an endpoint; the underlying
 * clients are built on first use and reused afterwards.
 */
export function createAzureProvider(options: AzureProviderOptions = {}): LLMClient {
  const clients = new Map<string, Promise<OpenAIClientLike>>();
  const streamOptions =
    options.includeUsage === undefined ? {} : { includeUsage: options.includeUsage };

  const clientFor = (config: AzureConfig): Promise<OpenAIClientLike> => {
    if (options.client) return Promise.resolve(options.client);
    const key = `${config.endpoint ?? ""}:${config.deployment}:${config.apiVersion}`;
    const existing = clients.get(key);
    if (existing) return existing;
    // Config errors throw before this point, so only a loadable client is cached.
    const created = createAzureClient(config, options);
    clients.set(key, created);
    return created;
  };

  async function* source(request: LLMRequest): AsyncIterable<ProviderStreamEvent> {
    const config = resolveAzureConfig(request.model, options);
    const client = await clientFor(config);
    yield* openaiEventStream(client, azureStreamRequest(request, config.deployment), streamOptions);
  }

  return {
    stream(request: LLMRequest): AsyncIterable<StreamEvent> {
      return assembleStream(request.model, request.signal, () => source(request));
    },
    complete(request: LLMRequest) {
      return completeFromStream(this.stream(request));
    },
  };
}

/** Options accepted by {@link azureModel}. */
export interface AzureModelOptions extends AzureSpecOptions {
  /** Catalog id; defaults to `azure/<deployment>`. */
  id?: string;
  displayName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  cost?: ModelSpec["cost"];
  capabilities?: Partial<ModelCapabilities>;
  /** Environment variable holding the API key. */
  apiKeyEnv?: string;
  /** Register the resulting spec in the catalog. */
  register?: boolean;
}

/**
 * Build a spec for an Azure deployment.
 *
 * Azure catalogs are per-tenant — deployment names, quotas and the models
 * behind them are chosen by whoever provisioned the resource — so no fixed list
 * can be shipped and every Azure spec is built here.
 *
 * @param deployment - The deployment name Azure routes on.
 */
export function azureModel(deployment: string, options: AzureModelOptions = {}): AzureModelSpec {
  const entry: AzureModelSpec = {
    id: options.id ?? `azure/${deployment}`,
    provider: "azure",
    model: deployment,
    displayName: options.displayName ?? `Azure ${deployment}`,
    contextWindow: options.contextWindow ?? 128_000,
    maxOutputTokens: options.maxOutputTokens ?? 16_384,
    capabilities: {
      tools: true,
      vision: true,
      thinking: false,
      caching: true,
      ...options.capabilities,
    },
    apiKeyEnv: options.apiKeyEnv ?? AZURE_API_KEY_ENV,
  };
  const providerOptions: AzureSpecOptions = {
    ...(options.endpoint !== undefined ? { endpoint: options.endpoint } : {}),
    ...(options.deployment !== undefined ? { deployment: options.deployment } : {}),
    ...(options.apiVersion !== undefined ? { apiVersion: options.apiVersion } : {}),
  };
  if (Object.keys(providerOptions).length > 0) entry.providerOptions = providerOptions;
  if (options.cost) entry.cost = options.cost;
  if (options.register) registerModel(entry);
  return entry;
}
