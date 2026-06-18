import type { MessageParam } from "@anthropic-ai/sdk/resources/messages/messages";

import {
  DEFAULT_MAX_TOKENS,
  DEFAULT_MODEL,
  getAnthropicClient,
} from "./anthropic.js";
import {
  decideRetry,
  getMaxRetries,
  sleepWithAbort,
} from "./withRetry.js";
import type {
  ContentBlock,
  StreamEvent,
  StreamRequestParams,
  StreamResult,
  TextBlock,
  ToolUseBlock,
  Usage,
} from "../../types/message.js";

function compactContentBlocks(blocks: ContentBlock[]): ContentBlock[] {
  return blocks.filter((block): block is ContentBlock => block !== undefined);
}

export async function* streamMessage(
  params: StreamRequestParams,
): AsyncGenerator<StreamEvent, StreamResult> {
  const client = getAnthropicClient();
  const maxRetries = params.maxRetries ?? getMaxRetries();
  let consecutive529 = 0;

  for (let attempt = 1; ; attempt++) {
    const contentBlocks: ContentBlock[] = [];
    let currentToolInputJson = "";
    const usage: Usage = { input_tokens: 0, output_tokens: 0 };
    let stopReason = "";
    let hasYieldedModelContent = false;

    try {
      const stream = client.messages.stream({
        model: params.model ?? DEFAULT_MODEL,
        max_tokens: params.maxTokens ?? DEFAULT_MAX_TOKENS,
        messages: params.messages as MessageParam[],
        stream: true,
        ...(params.tools && { tools: params.tools as never }),
        ...(params.system && { system: params.system }),
      }, params.signal ? { signal: params.signal } : undefined);

      for await (const event of stream) {
        switch (event.type) {
          case "message_start":
            usage.input_tokens = event.message.usage.input_tokens;
            if (
              typeof event.message.usage.cache_creation_input_tokens === "number"
            ) {
              usage.cache_creation_input_tokens =
                event.message.usage.cache_creation_input_tokens;
            }
            if (typeof event.message.usage.cache_read_input_tokens === "number") {
              usage.cache_read_input_tokens =
                event.message.usage.cache_read_input_tokens;
            }
            yield { type: "message_start", messageId: event.message.id };
            break;

          case "content_block_start":
            if (event.content_block.type === "text") {
              contentBlocks[event.index] = { type: "text", text: "" };
            } else if (event.content_block.type === "tool_use") {
              const block = event.content_block;
              contentBlocks[event.index] = {
                type: "tool_use",
                id: block.id,
                name: block.name,
                input: {},
              };
              currentToolInputJson = "";
              hasYieldedModelContent = true;
              yield { type: "tool_use_start", id: block.id, name: block.name };
            }
            break;

          case "content_block_delta":
            if (event.delta.type === "text_delta") {
              if (!contentBlocks[event.index]) {
                contentBlocks[event.index] = { type: "text", text: "" };
              }

              const block = contentBlocks[event.index] as TextBlock;
              block.text += event.delta.text;
              hasYieldedModelContent = true;
              yield { type: "text", text: event.delta.text };
            } else if (event.delta.type === "input_json_delta") {
              currentToolInputJson += event.delta.partial_json;
              hasYieldedModelContent = true;
              yield {
                type: "tool_use_input",
                partialJson: event.delta.partial_json,
              };
            }
            break;

          case "content_block_stop": {
            const block = contentBlocks[event.index];
            if (block?.type === "tool_use" && currentToolInputJson) {
              (block as ToolUseBlock).input = JSON.parse(currentToolInputJson);
              currentToolInputJson = "";
            }
            break;
          }

          case "message_delta":
            usage.output_tokens = event.usage.output_tokens;
            stopReason = event.delta.stop_reason ?? "";
            break;

          case "message_stop":
            yield { type: "message_done", stopReason, usage };
            break;
        }
      }

      return {
        assistantMessage: {
          role: "assistant",
          content: compactContentBlocks(contentBlocks),
        },
        usage,
        stopReason,
      };
    } catch (error) {
      if (hasYieldedModelContent) {
        throw error;
      }

      const decision = decideRetry(error, attempt, {
        maxRetries,
        querySource: params.querySource,
        consecutive529,
      });
      consecutive529 = decision.consecutive529;

      if (!decision.retry) {
        throw error;
      }

      const retryEvent = {
        type: "api_retry" as const,
        attempt,
        maxRetries,
        delayMs: decision.delayMs,
        category: decision.category,
        message: error instanceof Error ? error.message : String(error),
      };
      params.onRetry?.(retryEvent);
      yield retryEvent;
      await sleepWithAbort(decision.delayMs, params.signal);
    }
  }
}
