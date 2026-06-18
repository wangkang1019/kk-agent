import { existsSync } from "node:fs";

import type {
  SandboxRuntimeStatus,
  SandboxSettings,
} from "./types.js";

export interface RuntimeStatusParams {
  platform?: NodeJS.Platform | string;
  sandboxExecPath?: string;
  commandExists?: (filePath: string) => boolean;
}

const SHELL_OPERATORS = new Set(["&&", "||", ";", "|", "&"]);

export function getSandboxRuntimeStatus(
  params: RuntimeStatusParams = {},
): SandboxRuntimeStatus {
  const platform = params.platform ?? process.platform;
  const commandExists = params.commandExists ?? existsSync;

  if (platform === "darwin") {
    const sandboxExecPath = params.sandboxExecPath ?? "/usr/bin/sandbox-exec";
    const available = commandExists(sandboxExecPath);

    return {
      platform,
      supported: true,
      available,
      kind: "macos-sandbox-exec",
      ...(available
        ? {}
        : { reason: `${sandboxExecPath} is not available on this machine.` }),
    };
  }

  if (platform === "win32") {
    return {
      platform,
      supported: false,
      available: false,
      kind: "windows-unsupported",
      reason:
        "Windows hard sandboxing requires a native restricted-token/ACL runner and is not implemented in this stage.",
    };
  }

  return {
    platform,
    supported: false,
    available: false,
    kind: "unsupported",
    reason: `No Bash sandbox runtime is implemented for ${platform}.`,
  };
}

export function splitShellCommand(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < command.length; index++) {
    const char = command[index];
    const next = command[index + 1];

    if ((char === '"' || char === "'") && command[index - 1] !== "\\") {
      quote = quote === char ? null : quote ?? char;
      current += char;
      continue;
    }

    if (!quote) {
      const two = `${char}${next ?? ""}`;

      if (SHELL_OPERATORS.has(two)) {
        if (current.trim()) {
          segments.push(current.trim());
        }
        current = "";
        index++;
        continue;
      }

      if (SHELL_OPERATORS.has(char)) {
        if (current.trim()) {
          segments.push(current.trim());
        }
        current = "";
        continue;
      }
    }

    current += char;
  }

  if (current.trim()) {
    segments.push(current.trim());
  }

  return segments;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function patternToRegExp(pattern: string): RegExp {
  return new RegExp(
    `^${pattern.split("*").map(escapeRegExp).join(".*")}$`,
    "i",
  );
}

function matchesExcludedCommand(command: string, patterns: string[]): boolean {
  const segments = splitShellCommand(command);

  return patterns.some((pattern) => {
    const regex = patternToRegExp(pattern);
    return segments.some((segment) => regex.test(segment));
  });
}

export function shouldUseSandbox(
  input: {
    command: string;
    dangerouslyDisableSandbox?: boolean;
  },
  settings: SandboxSettings,
  runtime: SandboxRuntimeStatus,
): boolean {
  if (!settings.enabled || !runtime.available) {
    return false;
  }

  if (input.dangerouslyDisableSandbox) {
    return false;
  }

  if (matchesExcludedCommand(input.command, settings.excludedCommands)) {
    return false;
  }

  return true;
}
