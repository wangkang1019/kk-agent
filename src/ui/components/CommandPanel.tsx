import { Box, Text } from "ink";
import type { ReactNode } from "react";

import type { CommandPanelState } from "../commandPanel.js";

export function CommandPanel({
  panel,
}: {
  panel: CommandPanelState;
}): ReactNode {
  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" paddingX={1}>
      <Text color="cyan" bold>{panel.title}</Text>
      <Text dimColor>{panel.description}</Text>
      <Box flexDirection="column" marginTop={1}>
        {panel.options.length === 0 ? (
          <Text dimColor>No options available.</Text>
        ) : panel.options.map((option, index) => {
          const selected = index === panel.selectedIndex;
          const color = option.isDanger ? "red" : selected ? "cyan" : undefined;
          return (
            <Text key={option.id} color={color} bold={selected}>
              {selected ? "› " : "  "}
              {index + 1}. {option.label}
              {option.isCurrent ? <Text color="green"> current</Text> : null}
              <Text dimColor>  {option.description}</Text>
            </Text>
          );
        })}
      </Box>
      <Text dimColor>Up/Down select, Enter confirm, number shortcut, Esc cancel</Text>
    </Box>
  );
}
