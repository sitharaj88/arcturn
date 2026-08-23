/**
 * Provider registry.
 *
 * Adapters register a factory under a {@link ProviderId} instead of being
 * listed in one central `switch`, so a new backend is a new file plus one
 * registration call. {@link createClient} resolves and caches factories through
 * here.
 */

import type { LLMClient, ModelSpec, ProviderId } from "@arcturn/types";

/** Everything an adapter factory needs to build a client for one model. */
export interface ProviderFactoryContext {
  /** The model being dispatched, for adapters that vary by deployment. */
  spec: ModelSpec;
  /** Resolved API key, when one applies. */
  apiKey: string | undefined;
  /** Base URL from the spec, or the client-wide override. */
  baseUrl: string | undefined;
  /** Extra headers merged into every request. */
  headers: Record<string, string> | undefined;
  /**
   * Resolves a bearer token for providers behind OAuth, refreshing it when
   * expired. Absent when the host configured no OAuth store.
   */
  getAccessToken?: (provider: ProviderId) => Promise<string>;
}

/** Why a provider cannot be dispatched, reported before any request is sent. */
export interface ProviderPrecheckFailure {
  kind: "auth" | "invalidRequest";
  message: string;
}

/** Builds an {@link LLMClient} for one provider. */
export type ProviderFactory = (ctx: ProviderFactoryContext) => LLMClient;

export interface ProviderRegistration {
  id: ProviderId;
  factory: ProviderFactory;
  /**
   * Extra parts of the cache key, for adapters whose client identity depends
   * on more than provider/baseUrl/key — an AWS region or GCP project, say.
   */
  cacheKeyOf?: (spec: ModelSpec) => string;
  /**
   * Verifies the model can be dispatched before a request is built, returning
   * what is wrong. Providers using ambient credentials (an AWS profile, GCP
   * application-default credentials) return undefined and fail at call time.
   */
  checkCredentials?: (ctx: ProviderFactoryContext) => ProviderPrecheckFailure | undefined;
}

const registry = new Map<ProviderId, ProviderRegistration>();

/**
 * Register a provider adapter, replacing any previous registration.
 *
 * @param registration - The provider id and its factory.
 */
export function registerProviderFactory(registration: ProviderRegistration): void {
  registry.set(registration.id, registration);
}

/** Look up a registered provider. */
export function getProviderFactory(id: ProviderId): ProviderRegistration | undefined {
  return registry.get(id);
}

/** Every registered provider id, for diagnostics and `--list-providers`. */
export function listProviderIds(): ProviderId[] {
  return [...registry.keys()].sort();
}

/** Remove a registration. Primarily for tests. */
export function unregisterProviderFactory(id: ProviderId): void {
  registry.delete(id);
}
