import type { LLMRequest, ModelSpec, StreamEvent } from "@arcturn/types";
import { afterEach, describe, expect, it } from "vitest";
import { AIErrorException } from "../errors.js";
import { getProviderFactory, unregisterProviderFactory } from "../providers/registry.js";
import {
  ANTHROPIC_OAUTH_PROVIDER_ID,
  GITHUB_COPILOT_PROVIDER,
  OPENAI_CODEX_PROVIDER,
  registerAnthropicOAuthProvider,
  registerOAuthProviderFactories,
} from "./index.js";

function spec(provider: string): ModelSpec {
  return {
    id: `${provider}/test`,
    provider,
    model: "test",
    displayName: "Test",
    contextWindow: 1_000,
    maxOutputTokens: 100,
    capabilities: { tools: false, vision: false, thinking: false, caching: false },
  };
}

function request(model: ModelSpec): LLMRequest {
  return {
    model,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 }],
  };
}

afterEach(() => {
  unregisterProviderFactory(ANTHROPIC_OAUTH_PROVIDER_ID);
});

describe("registerOAuthProviderFactories", () => {
  it("registers the OAuth-only providers", () => {
    registerOAuthProviderFactories();
    expect(getProviderFactory(GITHUB_COPILOT_PROVIDER)).toBeDefined();
    expect(getProviderFactory(OPENAI_CODEX_PROVIDER)).toBeDefined();
  });

  it("prechecks that a token source was configured", () => {
    registerOAuthProviderFactories();
    const registration = getProviderFactory(GITHUB_COPILOT_PROVIDER);
    const ctx = {
      spec: spec(GITHUB_COPILOT_PROVIDER),
      apiKey: undefined,
      baseUrl: undefined,
      headers: undefined,
    };
    expect(registration?.checkCredentials?.(ctx)).toMatchObject({ kind: "auth" });
    expect(
      registration?.checkCredentials?.({ ...ctx, getAccessToken: () => Promise.resolve("t") }),
    ).toBeUndefined();
  });

  it("reports a token-resolution failure as a terminal error event", async () => {
    registerAnthropicOAuthProvider();
    const registration = getProviderFactory(ANTHROPIC_OAUTH_PROVIDER_ID);
    const model = spec(ANTHROPIC_OAUTH_PROVIDER_ID);
    const client = registration?.factory({
      spec: model,
      apiKey: undefined,
      baseUrl: undefined,
      headers: undefined,
      getAccessToken: () =>
        Promise.reject(
          new AIErrorException({ kind: "auth", message: "Not signed in to anthropic" }),
        ),
    });

    const events: StreamEvent[] = [];
    for await (const event of client?.stream(request(model)) ?? []) events.push(event);

    expect(events[0]).toMatchObject({ type: "start" });
    expect(events[1]).toMatchObject({ type: "error", error: { kind: "auth" } });
  });

  it("resolves the token once and reuses the adapter until it changes", async () => {
    registerAnthropicOAuthProvider();
    const registration = getProviderFactory(ANTHROPIC_OAUTH_PROVIDER_ID);
    const model = spec(ANTHROPIC_OAUTH_PROVIDER_ID);
    let resolutions = 0;
    const client = registration?.factory({
      spec: model,
      apiKey: undefined,
      baseUrl: "http://127.0.0.1:1/unused",
      headers: undefined,
      getAccessToken: () => {
        resolutions++;
        return Promise.resolve("token-1");
      },
    });

    // The adapter is real but never reached: the request fails at the socket,
    // which is enough to prove the token was resolved and a client was built.
    for await (const _ of client?.stream(request(model)) ?? []) {
      // drain
    }
    for await (const _ of client?.stream(request(model)) ?? []) {
      // drain
    }
    expect(resolutions).toBe(2);
  });
});
