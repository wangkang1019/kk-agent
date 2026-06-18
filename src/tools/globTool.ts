import type { Tool, ToolContext, ToolResult } from "./Tool.js";
import { resolveWorkspacePath } from "./pathUtils.js";
import { execFileText } from "./processUtils.js";

const DEFAULT_TIMEOUT_MS = 120_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === "string" ? value : undefined;
}

function normalizeOutput(output: string): string {
  return output.trim().replaceAll("\\", "/");
}

export const globTool: Tool = {
  name: "Glob",
  description: "Find files in the current workspace by glob pattern.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Glob pattern, for example **/*.ts.",
      },
      path: {
        type: "string",
        description: "Optional base path to search within.",
      },
    },
    required: ["pattern"],
  },
  async call(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    if (!isRecord(input) || typeof input.pattern !== "string" || !input.pattern) {
      return { content: "Glob requires a non-empty string pattern.", isError: true };
    }

    try {
      const cwd = resolveWorkspacePath(getString(input, "path") ?? ".", context.cwd);
      const result = await execFileText("rg", ["--files", "-g", input.pattern], {
        cwd,
        timeout: DEFAULT_TIMEOUT_MS,
        signal: context.abortSignal,
      });

      return { content: normalizeOutput(result.stdout) || "No files matched" };
    } catch (error) {
      const result = error as { stdout?: string; exitCode?: number };

      if (result.exitCode === 1) {
        return { content: normalizeOutput(result.stdout ?? "") || "No files matched" };
      }

      const message = error instanceof Error ? error.message : String(error);
      return { content: `Error: Glob failed: ${message}`, isError: true };
    }
  },
  isReadOnly(): boolean {
    return true;
  },
  isEnabled(): boolean {
    return true;
  },
  isConcurrencySafe(): boolean {
    return true;
  },
};
