export function formatTaskOutputLines(rawLines: string[]): string[] {
  return rawLines
    .filter((line) => line.trim())
    .map((line) => {
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        const type = event.type;

        if (type === "started") {
          return `Started ${String(event.agentType ?? "agent")} — ${String(event.description ?? "")}`.trim();
        }

        if (type === "text") {
          const text = String(event.text ?? "").trim();
          return text ? `text: ${text.slice(0, 180)}` : "text";
        }

        if (type === "tool_use") {
          return `tool: ${String(event.toolName ?? "unknown")}`;
        }

        if (type === "tool_result") {
          const status = event.isError === true ? "error" : "ok";
          const preview = event.preview ? `: ${String(event.preview).slice(0, 120)}` : "";
          return `result: ${String(event.toolName ?? "unknown")} ${status}${preview}`;
        }

        if (type === "turn_usage") {
          return `turn: ${Number(event.totalTokens ?? 0)} tokens (${Number(event.inputTokens ?? 0)} in, ${Number(event.outputTokens ?? 0)} out)`;
        }

        if (type === "completed") {
          return `Done · ${String(event.reason ?? "completed")} · ${Number(event.durationMs ?? 0)}ms · ${Number(event.toolUseCount ?? 0)} tools · ${Number(event.totalTokens ?? 0)} tokens`;
        }

        if (type === "failed") {
          return `Failed · ${String(event.error ?? "unknown error")} · ${Number(event.durationMs ?? 0)}ms`;
        }

        return `event: ${String(type ?? "unknown")}`;
      } catch {
        return `unreadable output line: ${line.slice(0, 120)}`;
      }
    });
}

export function selectRecentOutputLines(
  lines: string[],
  limit = 40,
): string[] {
  if (lines.length <= limit) {
    return lines;
  }

  return [
    `... ${lines.length - limit} earlier events hidden`,
    ...lines.slice(-limit),
  ];
}
