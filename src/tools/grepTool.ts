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

export const grepTool: Tool = {
  name: "Grep",
  description: "Search file contents in the current workspace using ripgrep.",
  inputSchema: {
    type: "object",
    properties: {
      pattern: {
        type: "string",
        description: "Text or regex pattern to search for.",
      },
      path: {
        type: "string",
        description: "Optional path to search within.",
      },
      include: {
        type: "string",
        description: "Optional file glob, for example *.ts.",
      },
    },
    required: ["pattern"],
  },
  async call(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    if (!isRecord(input) || typeof input.pattern !== "string" || !input.pattern) {
      return { content: "Grep requires a non-empty string pattern.", isError: true };
    }

    try {
      const targetPath = resolveWorkspacePath(getString(input, "path") ?? ".", context.cwd);
      const args = ["-n", input.pattern];
      const include = getString(input, "include");

      if (include) {
        args.push("-g", include);
      }

      args.push(targetPath);

      try {
        const result = await execFileText("rg", args, {
          timeout: DEFAULT_TIMEOUT_MS,
          signal: context.abortSignal,
        });
        return { content: normalizeOutput(result.stdout) || "No matches found" };
      } catch (error) {
        const result = error as { stdout?: string; exitCode?: number };

        if (result.exitCode === 1) {
          return { content: normalizeOutput(result.stdout ?? "") || "No matches found" };
        }

        throw error;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { content: `Error: Grep failed: ${message}`, isError: true };
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
