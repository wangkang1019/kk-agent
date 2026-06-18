import {
  classifyAPIError,
  is529Error,
  isRetryableError,
  type APIErrorCategory,
} from "./errors.js";

export type QuerySource =
  | "foreground"
  | "background"
  | "compact"
  | "session_memory";

export interface RetryInfo {
  attempt: number;
  maxRetries: number;
  delayMs: number;
  category: APIErrorCategory;
  message: string;
}

export interface RetryOptions {
  maxRetries?: number;
  querySource?: QuerySource;
  signal?: AbortSignal;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  onRetry?: (info: RetryInfo) => void;
}

export const DEFAULT_MAX_RETRIES = 10;
export const BASE_RETRY_DELAY_MS = 500;
export const MAX_RETRY_DELAY_MS = 32_000;
export const MAX_529_RETRIES = 3;

function getHeader(headers: unknown, name: string): unknown {
  if (!headers || typeof headers !== "object") {
    return undefined;
  }

  const maybeHeaders = headers as {
    get?: (key: string) => string | null;
  } & Record<string, unknown>;

  if (typeof maybeHeaders.get === "function") {
    return maybeHeaders.get(name);
  }

  return maybeHeaders[name] ?? maybeHeaders[name.toLowerCase()];
}

export function getRetryAfterMs(error: unknown): number | null {
  const headers = error && typeof error === "object"
    ? (error as { headers?: unknown }).headers
    : undefined;
  const retryAfter = getHeader(headers, "retry-after") ??
    (error && typeof error === "object"
      ? (error as { retryAfter?: unknown }).retryAfter
      : undefined);

  if (retryAfter === undefined || retryAfter === null || retryAfter === "") {
    return null;
  }

  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) {
    return Math.max(0, seconds * 1000);
  }

  const timestamp = Date.parse(String(retryAfter));
  if (Number.isFinite(timestamp)) {
    return Math.max(0, timestamp - Date.now());
  }

  return null;
}

export function getMaxRetries(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.KK_AGENT_MAX_RETRIES ?? env.EASY_AGENT_MAX_RETRIES;
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed >= 0
    ? parsed
    : DEFAULT_MAX_RETRIES;
}

export function getRetryDelay(
  attempt: number,
  retryAfterMs: number | null = null,
): number {
  if (typeof retryAfterMs === "number") {
    return retryAfterMs;
  }

  const base = Math.min(
    BASE_RETRY_DELAY_MS * 2 ** Math.max(0, attempt - 1),
    MAX_RETRY_DELAY_MS,
  );
  return Math.round(base + Math.random() * base * 0.25);
}

export function shouldRetry529(querySource: QuerySource = "foreground"): boolean {
  return querySource === "foreground";
}

export function decideRetry(
  error: unknown,
  attempt: number,
  options: RetryOptions & { consecutive529?: number } = {},
): {
  retry: boolean;
  delayMs: number;
  category: APIErrorCategory;
  consecutive529: number;
} {
  const category = classifyAPIError(error);
  const maxRetries = options.maxRetries ?? getMaxRetries();
  const consecutive529 = options.consecutive529 ?? 0;

  if (!isRetryableError(error) || attempt > maxRetries) {
    return { retry: false, delayMs: 0, category, consecutive529 };
  }

  if (is529Error(error)) {
    const next529 = consecutive529 + 1;

    if (!shouldRetry529(options.querySource) || next529 >= MAX_529_RETRIES) {
      return {
        retry: false,
        delayMs: 0,
        category,
        consecutive529: next529,
      };
    }

    return {
      retry: true,
      delayMs: getRetryDelay(attempt, getRetryAfterMs(error)),
      category,
      consecutive529: next529,
    };
  }

  return {
    retry: true,
    delayMs: getRetryDelay(attempt, getRetryAfterMs(error)),
    category,
    consecutive529: 0,
  };
}

export async function sleepWithAbort(
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) {
    throw new DOMException("Aborted", "AbortError");
  }

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, delayMs);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function callWithRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions = {},
): Promise<T> {
  let consecutive529 = 0;
  const maxRetries = options.maxRetries ?? getMaxRetries();
  const sleep = options.sleep ?? sleepWithAbort;

  for (let attempt = 1; ; attempt++) {
    try {
      return await operation(attempt);
    } catch (error) {
      const decision = decideRetry(error, attempt, {
        ...options,
        maxRetries,
        consecutive529,
      });
      consecutive529 = decision.consecutive529;

      if (!decision.retry) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      options.onRetry?.({
        attempt,
        maxRetries,
        delayMs: decision.delayMs,
        category: decision.category,
        message,
      });
      await sleep(decision.delayMs, options.signal);
    }
  }
}
