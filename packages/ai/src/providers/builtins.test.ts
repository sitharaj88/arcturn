/**
 * Registration-level behaviour of the built-in adapters.
 */

import { describe, expect, it } from "vitest";
import { openaiCompatible } from "../catalog.js";
import { createClient } from "../client.js";
import { listProviderIds } from "./registry.js";

describe("built-in provider registration", () => {
  it("registers every shipped adapter", () => {
    expect(listProviderIds()).toEqual(
      expect.arrayContaining([
        "anthropic",
        "anthropic-compatible",
        "azure",
        "bedrock",
        "google",
        "openai",
        "openai-compatible",
        "openai-responses",
        "vertex",
      ]),
    );
  });

  it("names the variable to set when a compatible spec expects a key", async () => {
    // Regression: a spec declaring apiKeyEnv used to fall through to the
    // placeholder credential, so a user who had simply not exported their key
    // saw the provider's opaque 401 instead of being told what to set.
    const spec = openaiCompatible("https://api.example.invalid/v1", "some-model", {
      apiKeyEnv: "EXAMPLE_API_KEY",
    });
    const client = createClient({ env: {} });

    const events = [];
    for await (const event of client.stream({
      model: spec,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 }],
    })) {
      if (event.type === "error") events.push(event.error);
    }

    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe("auth");
    expect(events[0]?.message).toContain("EXAMPLE_API_KEY");
  });

  it("builds a compatible endpoint that needs no API key", async () => {
    // Regression: local runtimes (Ollama, LM Studio, vLLM) authenticate with
    // nothing, and the precheck allows that — but both vendor SDKs throw at
    // construction when the key is absent, so the adapter must substitute a
    // placeholder. Previously this failed with "Missing credentials" before a
    // single byte was sent.
    const spec = openaiCompatible("http://127.0.0.1:9/v1", "local-model");
    const client = createClient({ env: {} });

    const kinds: string[] = [];
    for await (const event of client.stream({
      model: spec,
      messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 }],
    })) {
      if (event.type === "error") kinds.push(event.error.kind);
      if (event.type === "end") kinds.push("end");
    }

    // Port 9 refuses the connection: reaching a network error proves the client
    // was constructed and dispatched rather than rejected for a missing key.
    expect(kinds).toHaveLength(1);
    expect(kinds[0]).not.toBe("auth");
  });
});
