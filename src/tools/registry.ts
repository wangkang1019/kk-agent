import type { Tool as AnthropicTool } from "@anthropic-ai/sdk/resources/messages/messages";

import type { PermissionMode } from "../permissions/permissions.js";
import { getAllMcpTools } from "../services/mcp/registry.js";
import type { Tool } from "./Tool.js";
import { agentTool } from "./agentTool.js";
import { bashTool } from "./bashTool.js";
import { fileEditTool } from "./fileEditTool.js";
import { fileReadTool } from "./fileReadTool.js";
import { fileWriteTool } from "./fileWriteTool.js";
import { globTool } from "./globTool.js";
import { grepTool } from "./grepTool.js";
import { memoryWriteTool } from "./memoryWriteTool.js";
import { enterPlanModeTool, exitPlanModeTool } from "./planModeTools.js";
import { skillTool } from "./skillTool.js";
import { taskCreateTool } from "./taskCreateTool.js";
import { taskGetTool } from "./taskGetTool.js";
import { taskListTool } from "./taskListTool.js";
import { taskUpdateTool } from "./taskUpdateTool.js";
import { sendMessageTool, teamCreateTool, teamDeleteTool } from "./teamTools.js";
import { todoWriteTool } from "./todoWriteTool.js";

const ALL_TOOLS: Tool[] = [
  fileReadTool,
  fileWriteTool,
  fileEditTool,
  grepTool,
  globTool,
  taskCreateTool,
  taskListTool,
  taskGetTool,
  taskUpdateTool,
  todoWriteTool,
  memoryWriteTool,
  skillTool,
  agentTool,
  teamCreateTool,
  sendMessageTool,
  teamDeleteTool,
  enterPlanModeTool,
  exitPlanModeTool,
  bashTool,
];

export function getAllTools(): Tool[] {
  return [
    ...ALL_TOOLS,
    ...getAllMcpTools(),
  ].filter((tool) => tool.isEnabled());
}

export function findToolByName(name: string): Tool | undefined {
  return getAllTools().find((tool) => tool.name === name);
}

function getToolsForMode(mode: PermissionMode = "default"): Tool[] {
  const tools = getAllTools();

  if (mode === "plan") {
    return tools.filter((tool) => tool.name !== "EnterPlanMode");
  }

  return tools.filter((tool) => tool.name !== "ExitPlanMode");
}

export function getToolsApiParams(mode: PermissionMode = "default"): AnthropicTool[] {
  return getToolsForMode(mode).map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as AnthropicTool["input_schema"],
  }));
}
