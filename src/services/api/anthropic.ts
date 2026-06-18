import Anthropic from "@anthropic-ai/sdk";

export const DEFAULT_MODEL =
  process.env.ANTHROPIC_MODEL || "claude-sonnet-4-20250514";
export const CAPPED_DEFAULT_MAX_TOKENS = 8_000;
export const ESCALATED_MAX_TOKENS = 64_000;
export const COMPACT_MAX_OUTPUT_TOKENS = 20_000;
export const DEFAULT_MAX_TOKENS = CAPPED_DEFAULT_MAX_TOKENS;

let clientInstance: Anthropic | null = null;

export function getAnthropicClient(options?: {
  apiKey?: string;
  baseURL?: string;
}): Anthropic {
  if (clientInstance && !options) {
    return clientInstance;
  }

  const client = new Anthropic({
    apiKey: options?.apiKey ?? process.env.ANTHROPIC_AUTH_TOKEN,
    baseURL: options?.baseURL ?? process.env.ANTHROPIC_BASE_URL,
  });

  if (!options) {
    clientInstance = client;
  }

  return client;
}
