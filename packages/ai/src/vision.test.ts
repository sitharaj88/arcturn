import type { ImageContent, LLMRequest, Message, ModelSpec } from "@arcturn/types";
import { describe, expect, it } from "vitest";
import { downgradeImages, hasImageContent } from "./vision.js";

const IMAGE: ImageContent = { type: "image", data: "aGk=", mimeType: "image/png" };

/** A model spec with `vision` set either way. */
function spec(vision: boolean): ModelSpec {
  return {
    id: vision ? "anthropic/claude-sonnet-5" : "zai-api/glm-4.7",
    provider: vision ? "anthropic" : "openai",
    model: vision ? "claude-sonnet-5" : "glm-4.7",
    displayName: "test model",
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    capabilities: { tools: true, vision, thinking: false, caching: false },
  };
}

function request(vision: boolean, messages: Message[]): LLMRequest {
  return { model: spec(vision), messages, tools: [] };
}

describe("downgradeImages", () => {
  it("replaces images with a placeholder for a model that cannot see", () => {
    // Reproduces the GLM failure: Z.AI answers a content-part array with
    // `400 messages.content.type is invalid, allowed values: ['text']`.
    const out = downgradeImages(
      request(false, [
        {
          role: "user",
          content: [{ type: "text", text: "what is in this?" }, IMAGE],
          timestamp: 0,
        },
      ]),
    );
    const content = out.messages[0]?.role === "user" ? out.messages[0].content : [];
    expect(content.every((part) => part.type === "text")).toBe(true);
    expect(content).toHaveLength(2);
    // The model is told an image was there, so it never invents its contents.
    expect(JSON.stringify(content)).toContain("no vision support");
    expect(JSON.stringify(content)).toContain("image/png");
  });

  it("leaves a vision-capable model's images alone", () => {
    const input = request(true, [{ role: "user", content: [IMAGE], timestamp: 0 }]);
    const out = downgradeImages(input);
    expect(out).toBe(input);
    expect(hasImageContent(out.messages)).toBe(true);
  });

  it("returns the request untouched when there are no images at all", () => {
    const input = request(false, [
      { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 0 },
    ]);
    expect(downgradeImages(input)).toBe(input);
  });

  it("downgrades images returned by a tool, not just user attachments", () => {
    const out = downgradeImages(
      request(false, [
        {
          role: "toolResult",
          toolCallId: "c1",
          toolName: "screenshot",
          content: [IMAGE],
          isError: false,
          timestamp: 0,
        },
      ]),
    );
    expect(hasImageContent(out.messages)).toBe(false);
  });

  it("keeps untouched messages identical so history stays cheap to compare", () => {
    const plain: Message = { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 };
    const withImage: Message = { role: "user", content: [IMAGE], timestamp: 1 };
    const input = request(false, [plain, withImage]);
    const out = downgradeImages(input);
    expect(out.messages[0]).toBe(plain);
    expect(out.messages[1]).not.toBe(withImage);
  });
});

describe("hasImageContent", () => {
  it("finds images in user and tool-result messages", () => {
    expect(hasImageContent([{ role: "user", content: [IMAGE], timestamp: 0 }])).toBe(true);
    expect(
      hasImageContent([
        { role: "user", content: [{ type: "text", text: "no pictures" }], timestamp: 0 },
      ]),
    ).toBe(false);
  });
});
