import { Box, Text } from "ink";
import type { ReactNode } from "react";

import type { CommandSuggestion } from "../commandSuggestions.js";

const MAX_VISIBLE = 8;

function sourceLabel(source: CommandSuggestion["source"]): string {
  if (source === "built-in") return "built-in";
  if (source === "command") return "local";
  return "skill";
}

export function CommandSuggestions({
  items,
}: {
  items: CommandSuggestion[];
}): ReactNode {
  if (items.length === 0) {
    return null;
  }

  const selected = Math.max(0, items.findIndex((item) => item.isSelected));
  const start = Math.max(
    0,
    Math.min(selected - Math.floor(MAX_VISIBLE / 2), items.length - MAX_VISIBLE),
  );
  const visible = items.slice(start, start + MAX_VISIBLE);
  const nameWidth = Math.min(
    Math.max(...visible.map((item) => item.name.length)),
    28,
  );

  return (
    <Box flexDirection="column" marginTop={1} paddingX={1}>
      {visible.map((item) => {
        const selectedItem = item.isSelected === true;
        const padded = item.name.padEnd(nameWidth, " ");

        return (
          <Text key={`${item.source}-${item.name}`}>
            <Text color={selectedItem ? "cyan" : "gray"} bold={selectedItem}>
              {selectedItem ? "› " : "  "}
            </Text>
            <Text color={selectedItem ? "cyan" : undefined} bold={selectedItem}>
              {padded}
            </Text>
            <Text dimColor>
              {"  "}
              [{sourceLabel(item.source)}] {item.description}
            </Text>
          </Text>
        );
      })}
      <Text dimColor>
        ↑↓ navigate · Tab complete · Enter run
        {items.length > MAX_VISIBLE ? ` · ${selected + 1}/${items.length}` : ""}
      </Text>
    </Box>
  );
}
