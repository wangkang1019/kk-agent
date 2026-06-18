import { Box, Text } from "ink";
import type { ReactNode } from "react";

import type { TranscriptState } from "../hooks/useTranscript.js";

export function TranscriptOverlay({
  lines,
  totalLines,
  state,
}: {
  lines: string[];
  totalLines: number;
  state: TranscriptState;
}): ReactNode {
  return (
    <Box flexDirection="column">
      <Text color="cyan" bold>
        Transcript {totalLines === 0 ? 0 : state.scroll + 1}-
        {Math.min(totalLines, state.scroll + lines.length)} / {totalLines}
      </Text>
      {state.search && (
        <Text dimColor>
          search: {state.search}
          {state.isSearching ? "_" : ""}
        </Text>
      )}
      {lines.map((line, index) => (
        <Text
          key={`${state.scroll}-${index}`}
          color={
            state.search &&
              line.toLowerCase().includes(state.search.toLowerCase())
              ? "yellow"
              : undefined
          }
        >
          {line}
        </Text>
      ))}
      <Text dimColor>
        ↑/↓ scroll · PgUp/PgDn page · / search · n/N next · g/G top/bottom · Esc close
      </Text>
    </Box>
  );
}
