import type {
  CallToolResult,
  Tool as McpTool,
} from "@modelcontextprotocol/sdk/types.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

import type { ConnectedMcpServer } from "../../types/mcp.js";
import type { Tool, ToolContext, ToolResult } from "../../tools/Tool.js";

const MAX_MCP_DESCRIPTION_LENGTH = 2048;

export function normalizeNameForMcp(name: string): string {
  return String(name).replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
}

export function buildMcpToolName(serverName: string, toolName: string): string {
  const prefix = `mcp__${normalizeNameForMcp(serverName)}__`;
  const remaining = Math.max(1, 64 - prefix.length);
  return `${prefix}${normalizeNameForMcp(toolName).slice(0, remaining)}`;
}

function truncateDescription(description: string | undefined): string {
  if (!description) {
    return "";
  }

  if (description.length <= MAX_MCP_DESCRIPTION_LENGTH) {
    return description;
  }

  return `${description.slice(0, MAX_MCP_DESCRIPTION_LENGTH)}… [truncated]`;
}

function stringifyMcpContent(content: CallToolResult["content"]): string {
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((block) => {
      if (block.type === "text") {
        return block.text;
      }

      if (block.type === "image") {
        return `[image: ${block.mimeType}, ${block.data.length} base64 chars]`;
      }

      if (block.type === "audio") {
        return `[audio: ${block.mimeType}, ${block.data.length} base64 chars]`;
      }

      if (block.type === "resource") {
        if ("text" in block.resource) {
          return block.resource.text;
        }

        return `[resource: ${block.resource.uri}]`;
      }

      if (block.type === "resource_link") {
        return `[resource_link: ${block.uri}]`;
      }

      return `[unknown MCP content block]`;
    })
    .join("\n");
}

export function buildToolAdapter(
  connection: ConnectedMcpServer,
  mcpTool: McpTool,
): Tool {
  const fullName = buildMcpToolName(connection.name, mcpTool.name);
  const readOnly = mcpTool.annotations?.readOnlyHint === true;

  return {
    name: fullName,
    description: truncateDescription(mcpTool.description),
    inputSchema: (mcpTool.inputSchema ?? {
      type: "object",
      properties: {},
    }) as Tool["inputSchema"],
    isReadOnly: () => readOnly,
    isEnabled: () => true,
    async call(rawInput: Record<string, unknown>, _context: ToolContext): Promise<ToolResult> {
      try {
        const result = await connection.client.callTool(
          {
            name: mcpTool.name,
            arguments: rawInput,
          },
          CallToolResultSchema,
        ) as CallToolResult;

        return {
          content: stringifyMcpContent(result.content),
          isError: result.isError === true,
        };
      } catch (error) {
        return {
          content: `MCP tool "${fullName}" failed: ${error instanceof Error ? error.message : String(error)}`,
          isError: true,
        };
      }
    },
  };
}

export async function fetchToolsForConnection(
  connection: ConnectedMcpServer,
): Promise<Tool[]> {
  if (!connection.capabilities?.tools) {
    return [];
  }

  try {
    const result = await connection.client.listTools();
    return result.tools.map((tool) => buildToolAdapter(connection, tool));
  } catch {
    return [];
  }
}
