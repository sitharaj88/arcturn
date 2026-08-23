/**
 * Google Vertex AI adapter.
 *
 * Vertex publishes two model families behind one project/location endpoint, so
 * this adapter is a router rather than a third converter: Gemini requests go
 * through `@google/genai` in Vertex mode and reuse `google.ts`'s converters and
 * event stream, Claude requests go through `@anthropic-ai/vertex-sdk` and reuse
 * `anthropic.ts`'s. Nothing here re-implements message conversion, tool-call
 * accumulation or stream assembly.
 *
 * Authentication is application-default credentials throughout, so
 * `gcloud auth application-default login`, a service-account key named by
 * `GOOGLE_APPLICATION_CREDENTIALS` and workload identity all work unmodified.
 */

import type {
  LLMClient,
  LLMRequest,
  ModelCapabilities,
  ModelSpec,
  StreamEvent,
} from "@arcturn/types";
import type { GoogleAuthOptions } from "google-auth-library";
import { registerModel } from "../catalog.js";
import { AIErrorException } from "../errors.js";
import {
  assembleStream,
  completeFromStream,
  type ProviderStreamEvent,
} from "../internal/stream.js";
import { type AnthropicClientLike, anthropicEventStream } from "./anthropic.js";
import { type GoogleClientLike, googleEventStream } from "./google.js";
import type { ProviderFactoryContext, ProviderPrecheckFailure } from "./registry.js";

/** OAuth scope every Vertex call needs. */
export const VERTEX_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

/** Location used when neither the spec nor the environment names one. */
export const VERTEX_DEFAULT_LOCATION = "us-central1";

/** Environment variables consulted for the Google Cloud project, in order. */
export const VERTEX_PROJECT_ENV: readonly string[] = [
  "GOOGLE_CLOUD_PROJECT",
  "GCLOUD_PROJECT",
  "ANTHROPIC_VERTEX_PROJECT_ID",
];

/** Environment variables consulted for the Vertex location, in order. */
export const VERTEX_LOCATION_ENV: readonly string[] = [
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_CLOUD_REGION",
  "CLOUD_ML_REGION",
];

/** Loaded lazily so importing this module does not pay the SDK's startup cost. */
let vertexSdk: Promise<typeof import("@anthropic-ai/vertex-sdk")> | undefined;
function loadVertexSdk() {
  vertexSdk ??= import("@anthropic-ai/vertex-sdk");
  return vertexSdk;
}

/** Loaded lazily so importing this module does not pay the SDK's startup cost. */
let genaiSdk: Promise<typeof import("@google/genai")> | undefined;
function loadGenai() {
  genaiSdk ??= import("@google/genai");
  return genaiSdk;
}

/** Loaded lazily so importing this module does not pay the SDK's startup cost. */
let googleAuthSdk: Promise<typeof import("google-auth-library")> | undefined;
function loadGoogleAuth() {
  googleAuthSdk ??= import("google-auth-library");
  return googleAuthSdk;
}

/** Which SDK serves a Vertex model. */
export type VertexFamily = "gemini" | "anthropic";

/** A read-only environment map, defaulting to `process.env`. */
export type VertexEnv = Record<string, string | undefined>;

/**
 * Vertex deployment coordinates carried on a {@link ModelSpec}.
 *
 * Carried in `ModelSpec.providerOptions`, which addresses the service rather
 * than the request: these values select and cache the adapter, and are never
 * spread onto the wire payload.
 */
export type VertexSpecOptions = {
  /** Google Cloud project id owning the Vertex endpoint. */
  project?: string;
  /** Vertex location, e.g. `"us-central1"` or `"global"`. */
  location?: string;
  /** Overrides the family inferred from the model name. */
  family?: VertexFamily;
};

/** A {@link ModelSpec} carrying {@link VertexSpecOptions}. */
export type VertexModelSpec = ModelSpec & { providerOptions?: VertexSpecOptions };

/** Construction options for {@link createVertexProvider}. */
export interface VertexProviderOptions {
  /** Google Cloud project; overridden by the spec's `providerOptions.project`. */
  project?: string;
  /** Vertex location; overridden by the spec's `providerOptions.location`. */
  location?: string;
  /** Extra headers merged into every request. */
  headers?: Record<string, string>;
  /** Overrides application-default credentials (key file, scopes, ...). */
  googleAuthOptions?: GoogleAuthOptions;
  /** Environment used to resolve project and location. Defaults to `process.env`. */
  env?: VertexEnv;
  /** Pre-built Gemini client; primarily an injection seam for tests. */
  geminiClient?: GoogleClientLike;
  /** Pre-built Claude client; primarily an injection seam for tests. */
  anthropicClient?: AnthropicClientLike;
  /**
   * Resolves the project from ambient credentials when no explicit one is
   * configured. Defaults to `GoogleAuth#getProjectId`; injected by tests.
   */
  discoverProject?: () => Promise<string | undefined>;
}

/** Fully resolved Vertex coordinates for one model. */
export interface VertexConfig {
  project: string | undefined;
  location: string;
  family: VertexFamily;
}

/** Failure text shared by the precheck and the call-time guard. */
const NO_PROJECT =
  "No Google Cloud project for Vertex; set GOOGLE_CLOUD_PROJECT, pass " +
  "providerOptions.project on the model spec, or run " +
  "`gcloud auth application-default set-quota-project <project>`";

/** Messages google-auth-library uses when ambient credentials are unusable. */
const CREDENTIAL_FAILURE =
  /google oauth|default credentials|application[_ -]default|gcloud auth|unable to (detect|find) a project/i;

/**
 * Decide which SDK serves a model.
 *
 * Vertex model garden ids are prefixed by publisher, and Anthropic's are also
 * version-pinned (`claude-sonnet-4-5@20250929`).
 */
export function vertexFamily(model: string): VertexFamily {
  return /(^|\/)claude/i.test(model) ? "anthropic" : "gemini";
}

function processEnv(): VertexEnv {
  const globalProcess = (globalThis as { process?: { env?: VertexEnv } }).process;
  return globalProcess?.env ?? {};
}

function firstEnv(env: VertexEnv, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (value) return value;
  }
  return undefined;
}

function specOptions(spec: ModelSpec): VertexSpecOptions {
  const raw = (spec as VertexModelSpec).providerOptions;
  return raw && typeof raw === "object" ? raw : {};
}

/**
 * Resolve the project, location and family for one model.
 *
 * Precedence is spec `providerOptions`, then the provider options, then the
 * environment, then the {@link VERTEX_DEFAULT_LOCATION} default.
 */
export function resolveVertexConfig(
  spec: ModelSpec,
  options: VertexProviderOptions = {},
): VertexConfig {
  const fromSpec = specOptions(spec);
  const env = options.env ?? processEnv();
  return {
    project: fromSpec.project ?? options.project ?? firstEnv(env, VERTEX_PROJECT_ENV),
    location:
      fromSpec.location ??
      options.location ??
      firstEnv(env, VERTEX_LOCATION_ENV) ??
      VERTEX_DEFAULT_LOCATION,
    family: fromSpec.family ?? vertexFamily(spec.model),
  };
}

/**
 * Cache key contribution for the provider registry.
 *
 * Two specs sharing a provider id still need separate clients when they point
 * at different projects or locations.
 */
export function vertexCacheKey(spec: ModelSpec, options: VertexProviderOptions = {}): string {
  const config = resolveVertexConfig(spec, options);
  return `vertex:${config.project ?? "adc"}:${config.location}`;
}

/**
 * Pre-dispatch check.
 *
 * Credentials are ambient and must not be probed, so the only hard failure is a
 * project that cannot be named. A key file is accepted as proof of a project
 * because the JSON itself carries `project_id`.
 */
export function checkVertexCredentials(
  ctx: ProviderFactoryContext,
  options: VertexProviderOptions = {},
): ProviderPrecheckFailure | undefined {
  const env = options.env ?? processEnv();
  if (resolveVertexConfig(ctx.spec, options).project) return undefined;
  if (env.GOOGLE_APPLICATION_CREDENTIALS) return undefined;
  return { kind: "invalidRequest", message: `${NO_PROJECT} (model ${ctx.spec.id})` };
}

async function defaultDiscoverProject(): Promise<string | undefined> {
  try {
    const { GoogleAuth } = await loadGoogleAuth();
    return (await new GoogleAuth({ scopes: [VERTEX_SCOPE] }).getProjectId()) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Re-classify credential failures the SDKs report without an HTTP status.
 *
 * `AnthropicVertex` wraps a failed token exchange in a connection error, which
 * would otherwise be reported as `unknown` and retried forever.
 */
function asVertexError(err: unknown): unknown {
  if (err instanceof AIErrorException) return err;
  const source = typeof err === "object" && err !== null ? (err as Record<string, unknown>) : {};
  if (typeof source.status === "number") return err;
  const message = typeof source.message === "string" ? source.message : "";
  if (message !== "" && CREDENTIAL_FAILURE.test(message)) {
    return new AIErrorException({ kind: "auth", message }, { cause: err });
  }
  return err;
}

async function createGeminiClient(
  config: VertexConfig,
  options: VertexProviderOptions,
): Promise<GoogleClientLike> {
  const { GoogleGenAI } = await loadGenai();
  const params: Record<string, unknown> = {
    vertexai: true,
    location: config.location,
    ...(config.project ? { project: config.project } : {}),
    ...(options.headers ? { httpOptions: { headers: options.headers } } : {}),
  };
  // The genai SDK pins an older google-auth-library major than this package, so
  // the options object crosses the boundary structurally.
  if (options.googleAuthOptions) params.googleAuthOptions = options.googleAuthOptions;
  return new GoogleGenAI(
    params as ConstructorParameters<typeof GoogleGenAI>[0],
  ) as unknown as GoogleClientLike;
}

async function createClaudeClient(
  config: VertexConfig,
  options: VertexProviderOptions,
): Promise<AnthropicClientLike> {
  const { AnthropicVertex } = await loadVertexSdk();
  const params: Record<string, unknown> = {
    region: config.location,
    projectId: config.project ?? null,
    // Retries are handled by streamWithRetry, which honours AbortSignal.
    maxRetries: 0,
    ...(options.headers ? { defaultHeaders: options.headers } : {}),
  };
  if (options.googleAuthOptions) {
    const { GoogleAuth } = await loadGoogleAuth();
    // The vertex SDK pins an older google-auth-library major than this package,
    // so the instance crosses the boundary structurally.
    params.googleAuth = new GoogleAuth({ scopes: [VERTEX_SCOPE], ...options.googleAuthOptions });
  }
  return new AnthropicVertex(
    params as ConstructorParameters<typeof AnthropicVertex>[0],
  ) as unknown as AnthropicClientLike;
}

/**
 * Create an {@link LLMClient} backed by Vertex AI.
 *
 * One provider instance serves every model in a project/location pair; the
 * per-family SDK clients are built on first use and reused afterwards.
 */
export function createVertexProvider(options: VertexProviderOptions = {}): LLMClient {
  const clients = new Map<string, Promise<GoogleClientLike | AnthropicClientLike>>();
  let discovery: Promise<string | undefined> | undefined;

  const discoverProject = (): Promise<string | undefined> => {
    discovery ??= (options.discoverProject ?? defaultDiscoverProject)();
    return discovery;
  };

  // Injected doubles resolve without touching the SDKs; real clients are built
  // lazily behind a cached promise so import stays cheap.
  const clientFor = (config: VertexConfig): Promise<GoogleClientLike | AnthropicClientLike> => {
    if (config.family === "gemini" && options.geminiClient) {
      return Promise.resolve(options.geminiClient);
    }
    if (config.family === "anthropic" && options.anthropicClient) {
      return Promise.resolve(options.anthropicClient);
    }
    const key = `${config.family}:${config.project ?? ""}:${config.location}`;
    const existing = clients.get(key);
    if (existing) return existing;
    const created =
      config.family === "anthropic"
        ? createClaudeClient(config, options)
        : createGeminiClient(config, options);
    clients.set(key, created);
    return created;
  };

  async function* source(request: LLMRequest): AsyncIterable<ProviderStreamEvent> {
    try {
      const resolved = resolveVertexConfig(request.model, options);
      const project = resolved.project ?? (await discoverProject());
      if (!project) throw new AIErrorException({ kind: "auth", message: NO_PROJECT });
      const config: VertexConfig = { ...resolved, project };
      const client = await clientFor(config);
      yield* config.family === "anthropic"
        ? anthropicEventStream(client as AnthropicClientLike, request)
        : googleEventStream(client as GoogleClientLike, request);
    } catch (err) {
      throw asVertexError(err);
    }
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

/** Options accepted by {@link vertexModel}. */
export interface VertexModelOptions extends VertexSpecOptions {
  /** Catalog id; defaults to `vertex/<model>`. */
  id?: string;
  displayName?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  cost?: ModelSpec["cost"];
  capabilities?: Partial<ModelCapabilities>;
  /** Register the resulting spec in the catalog. */
  register?: boolean;
}

/**
 * Build an ad-hoc spec for any Vertex model, listed in the catalog or not.
 *
 * Vertex hosts the whole model garden plus tuned endpoints, so the shipped
 * catalog is a convenience rather than a closed set.
 *
 * @param model - Vertex model id, e.g. `"gemini-2.5-flash"` or
 *   `"claude-sonnet-4-5@20250929"`.
 */
export function vertexModel(model: string, options: VertexModelOptions = {}): VertexModelSpec {
  const family = options.family ?? vertexFamily(model);
  const entry: VertexModelSpec = {
    id: options.id ?? `vertex/${model}`,
    provider: "vertex",
    model,
    displayName: options.displayName ?? model,
    contextWindow: options.contextWindow ?? (family === "anthropic" ? 200_000 : 1_048_576),
    maxOutputTokens: options.maxOutputTokens ?? (family === "anthropic" ? 64_000 : 65_536),
    capabilities: {
      tools: true,
      vision: true,
      thinking: true,
      caching: true,
      ...options.capabilities,
    },
  };
  const providerOptions: VertexSpecOptions = {
    ...(options.project !== undefined ? { project: options.project } : {}),
    ...(options.location !== undefined ? { location: options.location } : {}),
    ...(options.family !== undefined ? { family: options.family } : {}),
  };
  if (Object.keys(providerOptions).length > 0) entry.providerOptions = providerOptions;
  if (options.cost) entry.cost = options.cost;
  if (options.register) registerModel(entry);
  return entry;
}
