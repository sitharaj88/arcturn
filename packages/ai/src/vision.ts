/**
 * Image handling for models that cannot see.
 *
 * Every {@link ModelSpec} declares `capabilities.vision`, but declaring it is
 * not enough: an image attached to a text-only model is serialised into the
 * request anyway and the provider rejects the whole call. Z.AI's GLM endpoint
 * answers with `400 messages.content.type is invalid, allowed values:
 * ['text']`, which tells the user nothing about what they did or how to
 * recover, and costs them the turn.
 *
 * {@link downgradeImages} makes the declared capability mean something. On a
 * model without vision, image blocks become a short text placeholder, so the
 * request succeeds and the model is told plainly that an image was attached and
 * that it cannot see it. Dropping the blocks silently would be worse — the
 * model would answer a question about a picture it was never told existed.
 *
 * @packageDocumentation
 */

import type { LLMRequest, Message, TextContent } from "@arcturn/types";

/** Stand-in text left in place of an image a model cannot see. */
function placeholder(mimeType: string): TextContent {
  return {
    type: "text",
    text:
      `[An image (${mimeType}) was attached here, but this model has no ` +
      "vision support and cannot see it. Say so rather than guessing at its " +
      "contents; the user can switch to a vision-capable model.]",
  };
}

/**
 * Replace image content with a text placeholder throughout one message.
 *
 * @returns The same message when it holds no images, so untouched history keeps
 *   its object identity and stays cheap to compare.
 */
function downgradeMessage(message: Message): Message {
  if (message.role === "assistant") return message;
  if (!message.content.some((part) => part.type === "image")) return message;
  const content = message.content.map((part) =>
    part.type === "image" ? placeholder(part.mimeType) : part,
  );
  return { ...message, content } as Message;
}

/**
 * Strip images from a request bound for a model that cannot see them.
 *
 * @param request - The outgoing request.
 * @returns The request unchanged when the model has vision or the conversation
 *   holds no images; otherwise a copy whose images are text placeholders.
 */
export function downgradeImages(request: LLMRequest): LLMRequest {
  if (request.model.capabilities.vision) return request;
  const messages = request.messages.map(downgradeMessage);
  if (messages.every((message, index) => message === request.messages[index])) return request;
  return { ...request, messages };
}

/**
 * Whether a request carries image content.
 *
 * Lets a caller warn *before* spending a turn, rather than discovering after
 * the fact that the model was told about a picture instead of shown one.
 *
 * @param messages - Conversation to inspect.
 */
export function hasImageContent(messages: readonly Message[]): boolean {
  return messages.some(
    (message) =>
      message.role !== "assistant" && message.content.some((part) => part.type === "image"),
  );
}
