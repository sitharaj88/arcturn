import { join } from "node:path";
import type { AIError, AssistantMessage, LLMClient, LLMRequest, StreamEvent } from "@arcturn/types";
import { describe, expect, it } from "vitest";
import type { DoctorCommand } from "./args.js";
import { parseArgs } from "./args.js";
import { runDoctorCommand } from "./doctor.js";
import { makeScratch, writeFileAt } from "./test-helpers/scratch.js";

function parseDoctor(argv: string[]): DoctorCommand {
  const result = parseArgs(argv);
  if (!result.ok) throw new Error(result.error);
  const command = result.args.command;
  if (command?.kind !== "doctor") throw new Error("expected a doctor command");
  return command;
}

/**
 * A client scripted per catalog id: listed ids terminate with that error
 * event, everything else answers cleanly. The shared `fakeLLM` helper cannot
 * script an `AIError.kind`, and the kind is exactly what doctor classifies.
 */
function scriptedClient(
  outcomes: Record<string, AIError> = {},
): LLMClient & { requests: LLMRequest[] } {
  const requests: LLMRequest[] = [];
  async function* stream(request: LLMRequest): AsyncIterable<StreamEvent> {
    requests.push(request);
    yield { type: "start", model: request.model.id };
    const error = outcomes[request.model.id];
    const usage = { inputTokens: 3, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 };
    const message: AssistantMessage = {
      role: "assistant",
      content: [],
      model: request.model.id,
      usage,
      stopReason: error === undefined ? "endTurn" : "error",
      ...(error === undefined ? {} : { errorMessage: error.message }),
      timestamp: Date.now(),
    };
    if (error !== undefined) {
      yield { type: "error", error, message };
      return;
    }
    yield { type: "usage", usage };
    yield { type: "end", message };
  }
  return {
    requests,
    stream,
    complete: () => Promise.reject(new Error("doctor must stream, not complete")),
  };
}

interface DoctorRun {
  code: number;
  out: string;
  err: string;
  requests: LLMRequest[];
}

async function runDoctor(
  argv: string[],
  env: Record<string, string | undefined>,
  outcomes: Record<string, AIError> = {},
  extra: { cwd?: string; fetchFn?: typeof fetch } = {},
): Promise<DoctorRun> {
  const command = parseDoctor(argv);
  const client = scriptedClient(outcomes);
  const out: string[] = [];
  const err: string[] = [];
  const code = await runDoctorCommand(command, {
    env,
    client,
    stdout: (text) => out.push(text),
    stderr: (text) => err.push(text),
    ...extra,
  });
  return { code, out: out.join(""), err: err.join(""), requests: client.requests };
}

describe("runDoctorCommand: one preset", () => {
  it("probes the curated head with one output token and reports ok", async () => {
    const { code, out, err, requests } = await runDoctor(["doctor", "zai"], {
      ZAI_API_KEY: "super-secret-key-material",
    });
    expect(code).toBe(0);
    expect(out).toContain("ok");
    expect(out).toContain("zai/glm-5.3");
    expect(out).toContain("ZAI_API_KEY ✓");
    // The plan endpoint has no per-token rate; the report must say so rather
    // than invent a price.
    expect(out).toContain("covered by plan");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.maxOutputTokens).toBe(1);
    // The one rule with no exception: key material never reaches any stream.
    expect(out + err).not.toContain("super-secret");
  });

  it("classifies a rejected key as auth failed and names the variable", async () => {
    const { code, out } = await runDoctor(
      ["doctor", "zai"],
      { ZAI_API_KEY: "bad" },
      { "zai/glm-5.3": { kind: "auth", message: "invalid api key", status: 401 } },
    );
    expect(code).toBe(1);
    expect(out).toContain("auth failed");
    expect(out).toContain("401");
    expect(out).toContain("ZAI_API_KEY");
  });

  it("reads Z.AI code 1113 as no balance, not rate limiting, and points at the siblings", async () => {
    const { code, out } = await runDoctor(
      ["doctor", "zai-api"],
      { ZAI_API_KEY: "coding-plan-key" },
      {
        "zai-api/glm-5.3": {
          kind: "rateLimit",
          message: "429 Insufficient balance or no resource package. Please recharge. (1113)",
          status: 429,
        },
      },
    );
    expect(code).toBe(1);
    expect(out).toContain("no balance");
    expect(out).not.toContain("rate limited");
    // zai-api's regionalVariants name the coding-plan endpoint the key may
    // actually belong to — the exact confusion this command exists to end.
    expect(out).toContain("try preset zai");
  });

  it("keeps an ordinary 429 as rate limited, with the retry-after", async () => {
    const { code, out } = await runDoctor(
      ["doctor", "groq"],
      { GROQ_API_KEY: "k" },
      {
        "groq/llama-3.3-70b-versatile": {
          kind: "rateLimit",
          message: "Too many requests",
          status: 429,
          retryAfterMs: 30_000,
        },
      },
    );
    expect(code).toBe(1);
    expect(out).toContain("rate limited");
    expect(out).toContain("retry in 30s");
  });

  it("reports an unreachable endpoint as network", async () => {
    const { code, out } = await runDoctor(
      ["doctor", "groq"],
      { GROQ_API_KEY: "k" },
      {
        "groq/llama-3.3-70b-versatile": {
          kind: "network",
          message: "fetch failed: ECONNREFUSED",
        },
      },
    );
    expect(code).toBe(1);
    expect(out).toContain("network");
    expect(out).toContain("ECONNREFUSED");
  });

  it("refuses to probe a preset whose key variable is unset", async () => {
    const { code, out, requests } = await runDoctor(["doctor", "groq"], {});
    expect(code).toBe(1);
    expect(out).toContain("no key");
    expect(out).toContain("GROQ_API_KEY");
    expect(requests).toHaveLength(0);
  });

  it("fails with no key — never a passing 'no known model' — for a keyless uncurated preset", async () => {
    // openrouter has no curated model, so a model id would have to come from
    // discovery — which itself needs the key. The key question must therefore
    // be answered first: without one the honest verdict is "no key", exit 1,
    // and nothing goes near the network.
    const fetched: string[] = [];
    const fetchFn: typeof fetch = async (input) => {
      fetched.push(String(input));
      throw new Error("doctor must not touch the network without a key");
    };
    const { code, out, requests } = await runDoctor(["doctor", "openrouter"], {}, {}, { fetchFn });
    expect(code).toBe(1);
    expect(out).toContain("no key");
    expect(out).toContain("OPENROUTER_API_KEY");
    expect(out).not.toContain("no known model");
    expect(requests).toHaveLength(0);
    expect(fetched).toHaveLength(0);
  });

  it("keeps the non-failing 'no known model' row for a keyed preset discovery cannot name", async () => {
    const fetchFn: typeof fetch = async () =>
      new Response(JSON.stringify({ data: [] }), { status: 200 });
    const { code, out, requests } = await runDoctor(
      ["doctor", "openrouter"],
      { OPENROUTER_API_KEY: "k" },
      {},
      { fetchFn },
    );
    expect(code).toBe(0);
    expect(out).toContain("no known model");
    expect(out).toContain("--model");
    expect(requests).toHaveLength(0);
  });

  it("labels a provider's model-not-found answer as unknown model", async () => {
    const { code, out } = await runDoctor(
      ["doctor", "groq"],
      { GROQ_API_KEY: "k" },
      {
        "groq/llama-3.3-70b-versatile": {
          kind: "invalidRequest",
          status: 404,
          message: "The model `llama-3.3-70b-versatile` does not exist or you do not have access",
        },
      },
    );
    expect(code).toBe(1);
    expect(out).toContain("unknown model");
  });

  it("recognises an Anthropic-flattened not_found_error body as unknown model", async () => {
    // The Anthropic SDK stringifies the whole error body into the message, so
    // "not_found_error" precedes the word "model" — the classifier must not
    // depend on the two appearing in prose order.
    const { code, out } = await runDoctor(
      ["doctor", "zai"],
      { ZAI_API_KEY: "k" },
      {
        "zai/glm-5.3": {
          kind: "invalidRequest",
          status: 404,
          message:
            '404 {"type":"error","error":{"type":"not_found_error","message":"model: glm-nope"}}',
        },
      },
    );
    expect(code).toBe(1);
    expect(out).toContain("unknown model");
  });

  it("keeps a 400 that merely mentions the model out of the unknown-model verdict", async () => {
    // "max_tokens exceeds this model's limit" is a request problem, not a bad
    // model id — calling it "unknown model" sends the operator to fix an id
    // that is fine. It must fall through to the generic error verdict.
    const { code, out } = await runDoctor(
      ["doctor", "groq"],
      { GROQ_API_KEY: "k" },
      {
        "groq/llama-3.3-70b-versatile": {
          kind: "invalidRequest",
          status: 400,
          message: "max_tokens exceeds this model's limit",
        },
      },
    );
    expect(code).toBe(1);
    expect(out).not.toContain("unknown model");
    expect(out).toContain("max_tokens exceeds");
  });

  it("never probes a Cloudflare base URL that still carries placeholders", async () => {
    const { code, out, requests } = await runDoctor(["doctor", "cloudflare-workers-ai"], {
      CLOUDFLARE_API_KEY: "k",
    });
    expect(code).toBe(0);
    expect(out).toContain("needs substitution");
    expect(requests).toHaveLength(0);
  });

  it("exits 2 on an unknown preset, listing the valid ones", async () => {
    const { code, err, requests } = await runDoctor(["doctor", "nope"], {});
    expect(code).toBe(2);
    expect(err).toContain('unknown preset "nope"');
    expect(err).toContain("groq");
    expect(err).toContain("quote it");
    expect(requests).toHaveLength(0);
  });

  it("exits 2 when --model is given without a preset", async () => {
    const errors: string[] = [];
    const code = await runDoctorCommand(
      { kind: "doctor" },
      { env: {}, model: "glm-5.3", stderr: (text) => errors.push(text) },
    );
    expect(code).toBe(2);
    expect(errors.join("")).toContain("--model needs a preset");
  });
});

describe("runDoctorCommand: default scan", () => {
  it("probes config-referenced models plus key-present presets, skipping the rest", async () => {
    const scratch = await makeScratch();
    await writeFileAt(
      join(scratch.cwd, ".arcturn", "config.json"),
      JSON.stringify({ model: "zai/glm-5.3" }),
    );
    const { code, out, requests } = await runDoctor(
      ["doctor"],
      { ARCTURN_HOME: scratch.home, ZAI_API_KEY: "k" },
      {},
      { cwd: scratch.cwd },
    );
    expect(code).toBe(0);
    // The config row carries what referenced it; the zai preset is covered by
    // it, so only zai-api is scanned on top.
    expect(out).toContain("for: model");
    const probed = requests.map((request) => request.model.id).sort();
    expect(probed).toEqual(["zai-api/glm-5.3", "zai/glm-5.3"]);
    // Key-absent presets are skipped in bulk, not probed and not enumerated.
    expect(out).toContain("Skipped");
    expect(out).not.toContain("GROQ_API_KEY");
  });

  it("flags a split-brain route.main and probes every failover link", async () => {
    const scratch = await makeScratch();
    await writeFileAt(
      join(scratch.cwd, ".arcturn", "config.json"),
      JSON.stringify({
        model: ["zai/glm-5.3", "zai-api/glm-4.7"],
        route: { main: "zai-api/glm-5" },
      }),
    );
    const { code, out, requests } = await runDoctor(
      ["doctor"],
      { ARCTURN_HOME: scratch.home, ZAI_API_KEY: "k" },
      {},
      { cwd: scratch.cwd },
    );
    expect(code).toBe(0);
    expect(out).toContain("the chat obeys route.main");
    expect(out).toContain("failover chain");
    const probed = requests.map((request) => request.model.id).sort();
    expect(probed).toEqual(["zai-api/glm-4.7", "zai-api/glm-5", "zai/glm-5.3"]);
  });

  it("fails when the session model's key is absent, without sending anything", async () => {
    const scratch = await makeScratch();
    const { code, out, requests } = await runDoctor(
      ["doctor"],
      { ARCTURN_HOME: scratch.home },
      {},
      { cwd: scratch.cwd },
    );
    expect(code).toBe(1);
    // No config file: the built-in default model is what a session would use,
    // and with no key it is a broken setup, not an empty report.
    expect(out).toContain("anthropic/claude-sonnet-4-5");
    expect(out).toContain("no key");
    expect(out).toContain("ANTHROPIC_API_KEY");
    expect(requests).toHaveLength(0);
  });
});
