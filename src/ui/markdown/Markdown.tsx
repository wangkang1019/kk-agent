import { Text } from "ink";
import type { ReactNode } from "react";

import {
  markdownToAnsiLines,
  streamingMarkdownToLines,
} from "./markdownToAnsi.js";

export function MarkdownText({ content }: { content: string }): ReactNode {
  return <Text>{markdownToAnsiLines(content).join("\n")}</Text>;
}

export function StreamingMarkdownText({
  content,
}: {
  content: string;
}): ReactNode {
  return <Text>{streamingMarkdownToLines(content).join("\n")}</Text>;
}
