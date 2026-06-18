export type APIErrorCategory =
  | "rate_limit"
  | "server_overload"
  | "server_error"
  | "auth_error"
  | "prompt_too_long"
  | "model_not_found"
  | "credit_balance"
  | "connection_error"
  | "api_timeout"
  | "aborted"
  | "unknown";

export interface PromptTooLongTokenCounts {
  actualTokens?: number;
  limitTokens?: number;
}

function getErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function getErrorName(error: unknown): string {
  if (!error || typeof error !== "object") {
    return "";
  }

  const name = (error as { name?: unknown }).name;
  return typeof name === "string" ? name : "";
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") {
      return message;
    }
  }

  return String(error ?? "");
}

export function classifyAPIError(error: unknown): APIErrorCategory {
  const status = getErrorStatus(error);
  const name = getErrorName(error);
  const message = getErrorMessage(error).toLowerCase();

  if (name === "AbortError" || message.includes("aborted")) {
    return "aborted";
  }

  if (status === 401 || status === 403) {
    return "auth_error";
  }

  if (status === 404) {
    return "model_not_found";
  }

  if (status === 429) {
    return "rate_limit";
  }

  if (status === 529 || message.includes("overloaded_error")) {
    return "server_overload";
  }

  if (
    status === 413 ||
    message.includes("prompt is too long") ||
    message.includes("context length") ||
    message.includes("maximum context")
  ) {
    return "prompt_too_long";
  }

  if (
    message.includes("credit balance") ||
    message.includes("insufficient credit") ||
    message.includes("billing")
  ) {
    return "credit_balance";
  }

  if (
    status === 408 ||
    message.includes("timeout") ||
    name.toLowerCase().includes("timeout")
  ) {
    return "api_timeout";
  }

  if (
    message.includes("econn") ||
    message.includes("network") ||
    message.includes("fetch failed") ||
    message.includes("socket") ||
    name.toLowerCase().includes("connection")
  ) {
    return "connection_error";
  }

  if (typeof status === "number" && status >= 500) {
    return "server_error";
  }

  return "unknown";
}

export function isPromptTooLongError(error: unknown): boolean {
  return classifyAPIError(error) === "prompt_too_long";
}

export function is529Error(error: unknown): boolean {
  return classifyAPIError(error) === "server_overload";
}

export function isRetryableError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const headers = (error as { headers?: unknown }).headers;
  const shouldRetry = typeof (headers as { get?: unknown })?.get === "function"
    ? (headers as { get(name: string): string | null }).get("x-should-retry")
    : typeof headers === "object" && headers !== null
      ? (headers as Record<string, unknown>)["x-should-retry"]
      : undefined;

  if (shouldRetry === "false") {
    return false;
  }

  return [
    "rate_limit",
    "server_overload",
    "server_error",
    "connection_error",
    "api_timeout",
  ].includes(classifyAPIError(error));
}

export function parsePromptTooLongTokenCounts(
  raw: unknown,
): PromptTooLongTokenCounts {
  const text = getErrorMessage(raw);
  const match = /([\d,]+)\s+tokens?\s*>\s*([\d,]+)\s+(?:maximum|max)/i
    .exec(text);

  if (!match) {
    return {};
  }

  return {
    actualTokens: Number(match[1]?.replace(/,/g, "")),
    limitTokens: Number(match[2]?.replace(/,/g, "")),
  };
}

export function getUserFacingErrorMessage(
  error: unknown,
  model = "current model",
): string {
  switch (classifyAPIError(error)) {
    case "auth_error":
      return "API Key 无效或已过期。请检查 ANTHROPIC_AUTH_TOKEN 或当前 Provider 的认证配置。";
    case "model_not_found":
      return `模型不可用或不存在：${model}。可以用 /model 切换模型后重试。`;
    case "credit_balance":
      return "账户余额不足或计费受限。请检查 Provider 账户余额后重试。";
    case "server_overload":
      return "模型服务当前过载。KK-Agent 已停止重试，请稍后再试。";
    case "prompt_too_long":
      return "对话上下文过长，超出模型窗口。可以使用 /compact 压缩，或 /clear 开始新上下文。";
    case "rate_limit":
      return "请求被限流。KK-Agent 已按退避策略重试，仍失败；请稍后再试。";
    case "api_timeout":
      return "模型请求超时。这通常是临时网络或服务问题，请稍后重试。";
    case "connection_error":
      return "连接模型服务失败。请检查网络、ANTHROPIC_BASE_URL 或中转服务状态。";
    case "aborted":
      return "请求已中断。";
    default:
      return `API 错误：${getErrorMessage(error) || "unknown error"}`;
  }
}
