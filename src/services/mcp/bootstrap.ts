import type { McpServerConnection, PendingMcpServer } from "../../types/mcp.js";
import {
  clearServerCache,
  connectToServer,
  registerMcpProcessCleanup,
} from "./client.js";
import { loadMcpConfigs, type LoadMcpConfigsParams } from "./config.js";
import { fetchToolsForConnection } from "./fetchTools.js";
import {
  clearMcpRegistry,
  deleteMcpRegistryEntry,
  getMcpRegistryEntry,
  setMcpRegistryEntry,
} from "./registry.js";

export interface McpBootstrapResult {
  connections: McpServerConnection[];
  toolCount: number;
  configErrors: string[];
}

export async function bootstrapMcp(
  params: string | LoadMcpConfigsParams,
): Promise<McpBootstrapResult> {
  const loadParams = typeof params === "string" ? { cwd: params } : params;
  const { servers, errors } = await loadMcpConfigs(loadParams);
  const startedAt = Date.now();

  registerMcpProcessCleanup();
  clearMcpRegistry();

  for (const [name, config] of Object.entries(servers)) {
    const pending: PendingMcpServer = {
      name,
      type: "pending",
      config,
      startedAt,
    };
    setMcpRegistryEntry(name, pending, []);
  }

  const settled = await Promise.allSettled(
    Object.entries(servers).map(([name, config]) => connectAndRegister(name, config)),
  );
  const connections: McpServerConnection[] = [];
  let toolCount = 0;

  for (const result of settled) {
    if (result.status === "fulfilled") {
      connections.push(result.value.connection);
      toolCount += result.value.toolCount;
    }
  }

  return {
    connections,
    toolCount,
    configErrors: errors,
  };
}

async function connectAndRegister(
  name: string,
  config: PendingMcpServer["config"],
): Promise<{ connection: McpServerConnection; toolCount: number }> {
  const connection = await connectToServer(name, config);
  const tools = connection.type === "connected"
    ? await fetchToolsForConnection(connection)
    : [];

  setMcpRegistryEntry(name, connection, tools);

  return { connection, toolCount: tools.length };
}

export async function reconnectMcpServer(
  name: string,
): Promise<McpServerConnection | null> {
  const entry = getMcpRegistryEntry(name);

  if (!entry) {
    return null;
  }

  await clearServerCache(name, entry.connection.config);
  deleteMcpRegistryEntry(name);
  const pending: PendingMcpServer = {
    name,
    type: "pending",
    config: entry.connection.config,
    startedAt: Date.now(),
  };
  setMcpRegistryEntry(name, pending, []);
  const result = await connectAndRegister(name, entry.connection.config);

  return result.connection;
}
