import { Box, Text } from "ink";
import type { ReactNode } from "react";

import type { PermissionDecision } from "../../permissions/permissions.js";
import {
  getPermissionPreviewLines,
  PERMISSION_OPTIONS,
} from "../permissionPrompt.js";

export function PermissionRequestCard({
  decision,
  selectedIndex,
}: {
  decision: PermissionDecision;
  selectedIndex: number;
}): ReactNode {
  const preview = getPermissionPreviewLines({
    toolName: decision.request.toolName,
    input: decision.request.input,
    summary: decision.request.summary,
  });

  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" paddingX={1}>
      <Text color="yellow" bold>
        Permission required: {decision.request.toolName}
      </Text>
      <Text dimColor>risk: {decision.request.risk}</Text>
      <Box flexDirection="column" marginTop={1}>
        {preview.map((line, index) => (
          <Text key={`${line}-${index}`}>{line}</Text>
        ))}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {PERMISSION_OPTIONS.map((option, index) => {
          const selected = index === selectedIndex;
          return (
            <Text key={option.shortcut} color={selected ? "cyan" : undefined}>
              {selected ? "› " : "  "}
              {index + 1}. {option.label}
              <Text dimColor> ({option.shortcut})</Text>
            </Text>
          );
        })}
      </Box>
      <Text dimColor>Up/Down select, Enter confirm, Esc cancel</Text>
    </Box>
  );
}
