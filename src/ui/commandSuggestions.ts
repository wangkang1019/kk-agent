import {
  getAllUserCommands,
  type UserCommand,
} from "../services/extensions/userCommands.js";
import { getAllUserInvocableSkills } from "../services/skills/registry.js";

export interface CommandSuggestion {
  name: string;
  description: string;
  source: "built-in" | "command" | "skill";
  isSelected?: boolean;
}

export const BUILT_IN_COMMAND_SUGGESTIONS: CommandSuggestion[] = [
  { name: "/help", description: "Show available commands", source: "built-in" },
  { name: "/clear", description: "Clear the current conversation", source: "built-in" },
  { name: "/compact", description: "Compress conversation context", source: "built-in" },
  { name: "/cost", description: "Show token usage", source: "built-in" },
  { name: "/history", description: "Show recent saved sessions", source: "built-in" },
  { name: "/resume", description: "Resume latest or selected saved session", source: "built-in" },
  { name: "/rewind", description: "Preview or restore files to an earlier turn", source: "built-in" },
  { name: "/mcp", description: "Show MCP server status", source: "built-in" },
  { name: "/skills", description: "List loaded skills", source: "built-in" },
  { name: "/commands", description: "List user-defined commands", source: "built-in" },
  { name: "/agents", description: "List SubAgents and background jobs", source: "built-in" },
  { name: "/teams", description: "Show Agent Teams status", source: "built-in" },
  { name: "/sandbox", description: "Show Bash sandbox status", source: "built-in" },
  { name: "/hooks", description: "Show lifecycle hook status", source: "built-in" },
  { name: "/config", description: "View or edit merged settings", source: "built-in" },
  { name: "/output-style", description: "Show or change answer style", source: "built-in" },
  { name: "/tasks", description: "Show or switch task tracking mode", source: "built-in" },
  { name: "/mode", description: "Show or change permission mode", source: "built-in" },
  { name: "/model", description: "Show or change active model", source: "built-in" },
  { name: "/exit", description: "Exit the app", source: "built-in" },
  { name: "/quit", description: "Exit the app", source: "built-in" },
];

function fromUserCommand(command: UserCommand): CommandSuggestion {
  const hint = command.argumentHint ? ` ${command.argumentHint}` : "";
  return {
    name: `/${command.name}`,
    description: `${command.description}${hint}`,
    source: "command",
  };
}

export function getAllCommandSuggestions(): CommandSuggestion[] {
  const seen = new Set<string>();
  const suggestions: CommandSuggestion[] = [];

  for (const item of BUILT_IN_COMMAND_SUGGESTIONS) {
    seen.add(item.name);
    suggestions.push(item);
  }

  for (const command of getAllUserCommands()) {
    const item = fromUserCommand(command);
    if (!seen.has(item.name)) {
      seen.add(item.name);
      suggestions.push(item);
    }
  }

  for (const skill of getAllUserInvocableSkills()) {
    const item: CommandSuggestion = {
      name: `/${skill.name}`,
      description: skill.description,
      source: "skill",
    };
    if (!seen.has(item.name)) {
      seen.add(item.name);
      suggestions.push(item);
    }
  }

  return suggestions;
}

function scoreSuggestion(
  suggestion: CommandSuggestion,
  query: string,
): number | null {
  const name = suggestion.name.slice(1).toLowerCase();
  const description = suggestion.description.toLowerCase();

  if (!query) return 0;
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  if (description.includes(query)) return 3;
  return null;
}

export function filterCommandSuggestions(
  input: string,
  options?: {
    selectedIndex?: number;
    max?: number;
    suggestions?: CommandSuggestion[];
  },
): CommandSuggestion[] {
  if (!input.startsWith("/") || /\s/.test(input)) {
    return [];
  }

  const query = input.trim().slice(1).toLowerCase();
  const source = options?.suggestions ?? getAllCommandSuggestions();
  const ranked = source
    .map((suggestion) => ({
      suggestion,
      score: scoreSuggestion(suggestion, query),
    }))
    .filter((item): item is { suggestion: CommandSuggestion; score: number } =>
      item.score !== null
    )
    .sort((left, right) => {
      if (left.score !== right.score) return left.score - right.score;
      if (left.suggestion.source !== right.suggestion.source) {
        const order = { "built-in": 0, command: 1, skill: 2 };
        return order[left.suggestion.source] - order[right.suggestion.source];
      }
      return left.suggestion.name.localeCompare(right.suggestion.name);
    })
    .map((item) => item.suggestion)
    .slice(0, options?.max ?? 20);

  const selected = Math.max(
    0,
    Math.min(options?.selectedIndex ?? 0, ranked.length - 1),
  );

  return ranked.map((item, index) => ({
    ...item,
    isSelected: index === selected,
  }));
}

export function moveCommandSelection(
  current: number,
  direction: "up" | "down",
  length: number,
): number {
  if (length <= 0) return 0;
  if (direction === "up") {
    return (current - 1 + length) % length;
  }
  return (current + 1) % length;
}

export function completeCommandSuggestion(
  suggestion: Pick<CommandSuggestion, "name">,
): string {
  return `${suggestion.name} `;
}
