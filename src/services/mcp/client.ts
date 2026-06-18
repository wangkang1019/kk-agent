import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import type {
  ConnectedMcpServer,
  McpHttpServerConfig,
  McpServerConnection,
  McpSseServerConfig,
  McpStdioServerConfig,
  ScopedMcpServerConfig,
} from "../../types/mcp.js";

const DEFAULT_CONNECT_TIMEOUT_MS = 30_000;

interface TransportBundle {
  transport: Transport;
  describe: string;
  collectStderrTail: () => string;
  preCleanup: () => Promise<void>;
}

const connectionCache = new Map<string, Promise<McpServerConnection>>();
const activeConnections = new Map<string, ConnectedMcpServer>();
let cleanupRegistered = false;

function getConnectTimeoutMs(): number {
  const parsed = Number.parseInt(process.env.MCP_CONNECT_TIMEOUT ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_CONNECT_TIMEOUT_MS;
}

function getCacheKey(name: string, config: ScopedMcpServerConfig): string {
  if (config.type === "http" || config.type === "sse") {
    return `${name}:${JSON.stringify({
      type: config.type,
      url: config.url,
      headers: config.headers,
    })}`;
  }

  return `${name}:${JSON.stringify({
    type: "stdio",
    command: config.command,
    args: config.args,
    env: config.env,
  })}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function escalatedKill(pid: number | null | undefined): Promise<void> {
  if (!pid) {
    return;
  }

  const isAlive = (): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  try {
    process.kill(pid, "SIGINT");
  } catch {
    return;
  }

  await sleep(100);
  if (!isAlive()) {
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }

  await sleep(400);
  if (!isAlive()) {
    return;
  }

  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Process already exited.
  }
}

function createStdioTransport(
  config: McpStdioServerConfig & { scope: string },
): TransportBundle {
  const transport = new StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
    env: {
      ...(process.env as Record<string, string>),
      ...(config.env ?? {}),
    },
    stderr: "pipe",
  });
  let stderr = "";

  transport.stderr?.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-64 * 1024);
  });

  return {
    transport,
    describe: `stdio: ${config.command} ${(config.args ?? []).join(" ")}`.trim(),
    collectStderrTail: () => stderr,
    preCleanup: async () => {
      await escalatedKill(transport.pid);
    },
  };
}

function createHttpTransport(
  config: McpHttpServerConfig & { scope: string },
): TransportBundle {
  const transport = new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: {
      headers: {
        "User-Agent": "kk-agent/0.1.0",
        ...(config.headers ?? {}),
      },
    },
  });

  return {
    transport,
    describe: `http: ${config.url}`,
    collectStderrTail: () => "",
    preCleanup: async () => {},
  };
}

function createSseTransport(
  config: McpSseServerConfig & { scope: string },
): TransportBundle {
  const headers = {
    "User-Agent": "kk-agent/0.1.0",
    ...(config.headers ?? {}),
  };
  const transport = new SSEClientTransport(new URL(config.url), {
    requestInit: { headers },
    eventSourceInit: {
      fetch: (url, init) =>
        fetch(url, {
          ...init,
          headers: {
            ...(init?.headers as Record<string, string> | undefined),
            ...headers,
            Accept: "text/event-stream",
          },
        }),
    },
  });

  return {
    transport,
    describe: `sse: ${config.url}`,
    collectStderrTail: () => "",
    preCleanup: async () => {},
  };
}

function createTransportBundle(
  config: ScopedMcpServerConfig,
): TransportBundle {
  if (config.type === "http") {
    return createHttpTransport(config);
  }

  if (config.type === "sse") {
    return createSseTransport(config);
  }

  return createStdioTransport(config);
}

export function connectToServer(
  name: string,
  config: ScopedMcpServerConfig,
): Promise<McpServerConnection> {
  const key = getCacheKey(name, config);
  const cached = connectionCache.get(key);

  if (cached) {
    return cached;
  }

  const promise = doConnect(name, config);
  connectionCache.set(key, promise);
  void promise.then((connection) => {
    if (connection.type === "connected") {
      activeConnections.set(name, connection);
    }
  });
  return promise;
}

async function doConnect(
  name: string,
  config: ScopedMcpServerConfig,
): Promise<McpServerConnection> {
  let bundle: TransportBundle;

  try {
    bundle = createTransportBundle(config);
  } catch (error) {
    return {
      name,
      type: "failed",
      config,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const client = new Client(
    { name: "kk-agent", version: "0.1.0" },
    { capabilities: { roots: {} } },
  );
  const timeoutMs = getConnectTimeoutMs();
  let timeout: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([
      client.connect(bundle.transport),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`connection timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    if (timeout) {
      clearTimeout(timeout);
    }

    try {
      await bundle.transport.close();
    } catch {
      // Best effort cleanup.
    }

    const stderr = bundle.collectStderrTail().trim();
    const message = error instanceof Error ? error.message : String(error);
    return {
      name,
      type: "failed",
      config,
      error: stderr ? `${message} (stderr: ${stderr.slice(0, 200)})` : message,
    };
  }

  if (timeout) {
    clearTimeout(timeout);
  }

  const cleanup = async (): Promise<void> => {
    activeConnections.delete(name);
    await bundle.preCleanup();
    try {
      await client.close();
    } catch {
      // Best effort cleanup.
    }
  };
  const serverVersion = client.getServerVersion();

  return {
    name,
    type: "connected",
    client,
    capabilities: client.getServerCapabilities(),
    ...(serverVersion && {
      serverInfo: {
        name: serverVersion.name,
        version: serverVersion.version,
      },
    }),
    config,
    cleanup,
  };
}

export async function clearServerCache(
  name: string,
  config: ScopedMcpServerConfig,
): Promise<void> {
  connectionCache.delete(getCacheKey(name, config));
  const existing = activeConnections.get(name);

  if (existing) {
    activeConnections.delete(name);
    await existing.cleanup();
  }
}

export function registerMcpProcessCleanup(): void {
  if (cleanupRegistered) {
    return;
  }

  cleanupRegistered = true;
  const cleanupAll = (): void => {
    const connections = Array.from(activeConnections.values());
    activeConnections.clear();
    void Promise.allSettled(connections.map((connection) => connection.cleanup()));
  };

  process.once("SIGINT", cleanupAll);
  process.once("SIGTERM", cleanupAll);
  process.once("beforeExit", cleanupAll);
}

export function _resetMcpClientForTesting(): void {
  connectionCache.clear();
  activeConnections.clear();
}
