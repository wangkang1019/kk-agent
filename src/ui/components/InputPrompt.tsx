import { Box, Text } from "ink";
import type { ReactNode } from "react";

function splitCursor(value: string, cursor: number): {
  lines: string[];
  cursorLine: number;
  cursorColumn: number;
} {
  const lines = value.split("\n");
  let remaining = cursor;

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (remaining <= line.length) {
      return {
        lines,
        cursorLine: index,
        cursorColumn: remaining,
      };
    }
    remaining -= line.length + 1;
  }

  return {
    lines,
    cursorLine: Math.max(0, lines.length - 1),
    cursorColumn: lines.at(-1)?.length ?? 0,
  };
}

function lineParts(line: string, cursorColumn: number | null): ReactNode {
  if (cursorColumn === null) {
    return <Text>{line || " "}</Text>;
  }

  const before = line.slice(0, cursorColumn);
  const cursorChar = line[cursorColumn] ?? " ";
  const after = line.slice(cursorColumn + (line[cursorColumn] ? 1 : 0));

  return (
    <Text>
      {before}
      <Text inverse>{cursorChar}</Text>
      {after}
    </Text>
  );
}

function commandColor(line: string, isFirstLine: boolean): string | undefined {
  return isFirstLine && line.startsWith("/") ? "cyan" : undefined;
}

export function InputPrompt({
  value,
  cursor,
}: {
  value: string;
  cursor: number;
}): ReactNode {
  const { lines, cursorLine, cursorColumn } = splitCursor(value, cursor);

  return (
    <Box
      marginTop={1}
      borderStyle="single"
      borderLeft={false}
      borderRight={false}
      paddingX={1}
      flexDirection="column"
    >
      {lines.map((line, index) => (
        <Box key={`input-${index}`}>
          <Text color="cyan" bold>
            {index === 0 ? "› " : "  "}
          </Text>
          <Text color={commandColor(line, index === 0)}>
            {lineParts(line, index === cursorLine ? cursorColumn : null)}
          </Text>
        </Box>
      ))}
    </Box>
  );
}
