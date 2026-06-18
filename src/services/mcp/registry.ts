import type { McpServerConnection } from "../../types/mcp.js";
import type { Tool } from "../../tools/Tool.js";

export interface McpRegistryEntry {
  connection: McpServerConnection;
  tools: Tool[];
}

const entries = new Map<string, McpRegistryEntry>();

export function setMcpRegistryEntry(
  name: string,
  connection: McpServerConnection,
  tools: Tool[],
): void {
  entries.set(name, { connection, tools });
}

export function deleteMcpRegistryEntry(name: string): void {
  entries.delete(name);
}

export function getMcpRegistry(): McpRegistryEntry[] {
  return Array.from(entries.values());
}

export function getMcpRegistryEntry(name: string): McpRegistryEntry | undefined {
  return entries.get(name);
}

export function getAllMcpTools(): Tool[] {
  return getMcpRegistry().flatMap((entry) => entry.tools);
}

export function clearMcpRegistry(): void {
  entries.clear();
}
