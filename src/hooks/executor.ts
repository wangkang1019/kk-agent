import { spawn } from "node:child_process";

import type {
  HookCommand,
  HookEvent,
  HookInput,
  HookPermissionBehavior,
  HookResult,
  HookShell,
} from "./types.js";

export interface ExecuteHookCommandParams {
  hook: HookCommand;
  hookEvent: HookEvent;
  hookName: string;
  hookInput: HookInput;
  cwd: string;
  signal?: AbortSignal;
}

interface ShellRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  timedOut?: boolean;
  aborted?: boolean;
}

export function getShellInvocation(
  command: string,
  shell?: HookShell,
): { file: string; args: string[] } {
  if (shell === "powershell") {
    return { file: "powershell.exe", args: ["-NoProfile", "-Command", command] };
  }

  if (shell === "cmd") {
    return { file: "cmd.exe", args: ["/d", "/s", "/c", command] };
  }

  if (shell === "bash") {
    return { file: "bash", args: ["-lc", command] };
  }

  if (shell === "sh") {
    return { file: "sh", args: ["-lc", command] };
  }

  if (process.platform === "win32") {
    return { file: "powershell.exe", args: ["-NoProfile", "-Command", command] };
  }

  return { file: process.env.SHELL || "bash", args: ["-lc", command] };
}

async function runShellCommand(
  hook: HookCommand,
  hookInput: HookInput,
  cwd: string,
  signal?: AbortSignal,
): Promise<ShellRunResult> {
  const timeoutMs = hook.timeout * 1000;
  const shell = getShellInvocation(hook.command, hook.shell);
  const start = Date.now();

  return new Promise((resolve) => {
    const child = spawn(shell.file, shell.args, {
      cwd,
      env: {
        ...process.env,
        KK_AGENT_PROJECT_DIR: cwd,
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;

    const finish = (exitCode: number): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({
        stdout,
        stderr,
        exitCode,
        durationMs: Date.now() - start,
        ...(timedOut && { timedOut }),
        ...(aborted && { aborted }),
      });
    };

    const onAbort = (): void => {
      aborted = true;
      child.kill();
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => {
      stderr ||= error.message;
      finish(1);
    });
    child.on("close", (code) => {
      finish(code ?? 1);
    });
    child.stdin.end(JSON.stringify(hookInput));
  });
}

function tryParseJson(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim();

  if (!trimmed.startsWith("{")) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function normalizePermission(value: unknown): HookPermissionBehavior | undefined {
  if (value === "approve" || value === "allow") {
    return "allow";
  }
  if (value === "ask") {
    return "ask";
  }
  if (value === "block" || value === "deny") {
    return "deny";
  }

  return undefined;
}

function decodeJsonOutput(
  json: Record<string, unknown>,
  command: string,
): Partial<HookResult> {
  const decoded: Partial<HookResult> = {};
  const decision = normalizePermission(json.decision);

  if (decision) {
    decoded.permissionBehavior = decision;
  }

  if (decision === "deny") {
    decoded.blockingError = typeof json.reason === "string"
      ? json.reason
      : `Blocked by hook: ${command}`;
  }

  if (json.continue === false) {
    decoded.preventContinuation = true;
    if (typeof json.stopReason === "string") {
      decoded.stopReason = json.stopReason;
    }
  }

  if (typeof json.systemMessage === "string") {
    decoded.systemMessage = json.systemMessage;
  }

  const specific = json.hookSpecificOutput;
  if (specific && typeof specific === "object" && !Array.isArray(specific)) {
    const record = specific as Record<string, unknown>;
    const permission = normalizePermission(record.permissionDecision);

    if (permission) {
      decoded.permissionBehavior = permission;
    }

    if (typeof record.permissionDecisionReason === "string") {
      decoded.permissionDecisionReason = record.permissionDecisionReason;
    }

    if (permission === "deny") {
      decoded.blockingError = decoded.permissionDecisionReason ??
        "Blocked by PreToolUse hook";
    }

    if (typeof record.additionalContext === "string") {
      decoded.additionalContext = record.additionalContext;
    }
  }

  return decoded;
}

export async function executeHookCommand(
  params: ExecuteHookCommandParams,
): Promise<HookResult> {
  const run = await runShellCommand(
    params.hook,
    params.hookInput,
    params.cwd,
    params.signal,
  );
  const base = {
    hookName: params.hookName,
    command: params.hook.command,
    ...run,
  };

  if (run.aborted) {
    return { ...base, outcome: "cancelled" };
  }

  if (run.timedOut) {
    return {
      ...base,
      outcome: "non_blocking_error",
      stderr: run.stderr || "Hook timed out.",
    };
  }

  const json = tryParseJson(run.stdout);
  const decoded = json ? decodeJsonOutput(json, params.hook.command) : {};

  if (run.exitCode === 0) {
    return {
      ...base,
      outcome: decoded.blockingError ? "blocking" : "success",
      ...decoded,
      additionalContext: decoded.additionalContext ??
        (run.stdout.trim() && !json ? run.stdout.trim() : undefined),
    };
  }

  if (run.exitCode === 2) {
    return {
      ...base,
      outcome: "blocking",
      ...decoded,
      permissionBehavior: decoded.permissionBehavior ?? "deny",
      blockingError: decoded.blockingError ??
        run.stderr.trim() ??
        "Hook exited with code 2.",
    };
  }

  return {
    ...base,
    outcome: decoded.blockingError ? "blocking" : "non_blocking_error",
    ...decoded,
  };
}
