import { spawn } from "node:child_process";

import {
  annotateStderrWithSandboxFailures,
  prepareBashCommand,
} from "../sandbox/index.js";
import {
  appendBashProgress,
  finishBashProgress,
} from "../state/bashProgressStore.js";
import type { Tool, ToolContext, ToolResult } from "./Tool.js";

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 30_000;

const READ_ONLY_COMMANDS = new Set([
  "cat",
  "dir",
  "find",
  "grep",
  "ls",
  "pwd",
  "rg",
  "type",
  "where",
  "which",
]);

const READ_ONLY_GIT_SUBCOMMANDS = new Set([
  "branch",
  "diff",
  "log",
  "show",
  "status",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function splitCommandSegments(command: string): string[] {
  return command
    .split(/&&|\|\||\|/)
    .map((segment) => segment.trim())
    .filter(Boolean);
}

function firstTokens(segment: string): string[] {
  return segment.split(/\s+/).filter(Boolean);
}

function hasWriteRedirection(segment: string): boolean {
  return /(^|[^>])>(?!>)/.test(segment) || />>/.test(segment);
}

function isReadOnlySegment(segment: string): boolean {
  if (hasWriteRedirection(segment)) {
    return false;
  }

  const [command, subcommand] = firstTokens(segment);
  const normalized = command?.toLowerCase();

  if (!normalized) {
    return false;
  }

  if (normalized === "git") {
    return subcommand ? READ_ONLY_GIT_SUBCOMMANDS.has(subcommand.toLowerCase()) : false;
  }

  return READ_ONLY_COMMANDS.has(normalized);
}

export function isReadOnlyShellCommand(command: string): boolean {
  const segments = splitCommandSegments(command);
  return segments.length > 0 && segments.every(isReadOnlySegment);
}

function truncateOutput(output: string): string {
  if (output.length <= MAX_OUTPUT_CHARS) {
    return output;
  }

  return `${output.slice(0, MAX_OUTPUT_CHARS)}\n[Output truncated to ${MAX_OUTPUT_CHARS} characters]`;
}

function getShellInvocation(command: string): { file: string; args: string[] } {
  if (process.platform === "win32") {
    return {
      file: "powershell.exe",
      args: ["-NoProfile", "-Command", command],
    };
  }

  return {
    file: process.env.SHELL || "bash",
    args: ["-lc", command],
  };
}

export const bashTool: Tool = {
  name: "Bash",
  description: "Run a shell command in the current workspace.",
  inputSchema: {
    type: "object",
    properties: {
      command: {
        type: "string",
        description: "Shell command to run.",
      },
      timeout_ms: {
        type: "number",
        description: "Optional timeout in milliseconds.",
      },
      dangerouslyDisableSandbox: {
        type: "boolean",
        description: "Run without the configured Bash sandbox. Use only when explicitly approved by the user.",
      },
    },
    required: ["command"],
  },
  async call(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    if (!isRecord(input) || typeof input.command !== "string" || !input.command.trim()) {
      return { content: "Bash requires a non-empty string command.", isError: true };
    }

    const command = input.command;
    const prepared = await prepareBashCommand({
      command,
      cwd: context.cwd,
      homeDir: context.homeDir,
      dangerouslyDisableSandbox: input.dangerouslyDisableSandbox === true,
    });

    if (prepared.blocked) {
      return {
        content: [
          "Sandbox: unavailable",
          `Error: Sandbox unavailable: ${prepared.reason ?? "runtime is unavailable"}`,
          "Unsandboxed fallback is disabled by configuration.",
        ].join("\n"),
        isError: true,
      };
    }

    const timeout =
      typeof input.timeout_ms === "number" && Number.isFinite(input.timeout_ms)
        ? input.timeout_ms
        : DEFAULT_TIMEOUT_MS;
    const shell = getShellInvocation(prepared.command);

    return new Promise<ToolResult>((resolve) => {
      const child = spawn(shell.file, shell.args, {
        cwd: context.cwd,
        env: process.env,
        windowsHide: true,
      });
      let stdout = "";
      let stderr = "";
      let settled = false;

      const finish = (result: ToolResult) => {
        if (settled) {
          return;
        }

        settled = true;
        resolve(result);
      };

      const timer = setTimeout(() => {
        child.kill();
        finishBashProgress(context.toolUseId, -1);
        finish({
          content: `Error: Command timed out after ${timeout}ms`,
          isError: true,
        });
      }, timeout);

      const abort = () => {
        child.kill();
        finishBashProgress(context.toolUseId, -1);
        finish({ content: "Error: Command aborted.", isError: true });
      };

      context.abortSignal?.addEventListener("abort", abort, { once: true });

      child.stdout.on("data", (chunk) => {
        const text = String(chunk);
        stdout += text;
        appendBashProgress(context.toolUseId, text, "stdout");
      });
      child.stderr.on("data", (chunk) => {
        const text = String(chunk);
        stderr += text;
        appendBashProgress(context.toolUseId, text, "stderr");
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        context.abortSignal?.removeEventListener("abort", abort);
        const exitCode = code ?? 0;
        finishBashProgress(context.toolUseId, exitCode);
        const stderrText = annotateStderrWithSandboxFailures(stderr.trim(), exitCode);

        finish({
          content: truncateOutput(
            [
              `Sandbox: ${prepared.status}`,
              `Exit code: ${exitCode}`,
              "STDOUT:",
              stdout.trim(),
              "STDERR:",
              stderrText,
            ].join("\n"),
          ),
          ...(exitCode !== 0 && { isError: true }),
        });
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        context.abortSignal?.removeEventListener("abort", abort);
        finishBashProgress(context.toolUseId, -1);
        finish({ content: `Error: ${error.message}`, isError: true });
      });
    });
  },
  isReadOnly(): boolean {
    return false;
  },
  isEnabled(): boolean {
    return true;
  },
};

export { annotateStderrWithSandboxFailures };
