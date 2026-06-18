import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { ServerCapabilities } from "@modelcontextprotocol/sdk/types.js";

export type McpConfigScope = "user" | "project";

export interface McpStdioServerConfig {
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpHttpServerConfig {
  type: "http";
  url: string;
  headers?: Record<string, string>;
}

export interface McpSseServerConfig {
  type: "sse";
  url: string;
  headers?: Record<string, string>;
}

export type McpServerConfig =
  | McpStdioServerConfig
  | McpHttpServerConfig
  | McpSseServerConfig;

export type ScopedMcpServerConfig = McpServerConfig & {
  scope: McpConfigScope;
};

export interface ConnectedMcpServer {
  name: string;
  type: "connected";
  client: Client;
  capabilities: ServerCapabilities | undefined;
  serverInfo?: {
    name: string;
    version: string;
  };
  config: ScopedMcpServerConfig;
  cleanup: () => Promise<void>;
}

export interface PendingMcpServer {
  name: string;
  type: "pending";
  config: ScopedMcpServerConfig;
  startedAt: number;
}

export interface FailedMcpServer {
  name: string;
  type: "failed";
  config: ScopedMcpServerConfig;
  error: string;
}

export interface DisabledMcpServer {
  name: string;
  type: "disabled";
  config: ScopedMcpServerConfig;
}

export type McpServerConnection =
  | ConnectedMcpServer
  | PendingMcpServer
  | FailedMcpServer
  | DisabledMcpServer;
