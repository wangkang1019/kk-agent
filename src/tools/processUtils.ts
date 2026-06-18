import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function execFileText(
  file: string,
  args: string[],
  options: {
    cwd?: string;
    timeout?: number;
    signal?: AbortSignal;
  } = {},
): Promise<ExecResult> {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      cwd: options.cwd,
      timeout: options.timeout,
      signal: options.signal,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    });

    return {
      stdout: String(stdout),
      stderr: String(stderr),
      exitCode: 0,
    };
  } catch (error) {
    const maybeError = error as {
      stdout?: unknown;
      stderr?: unknown;
      code?: unknown;
    };

    throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
      stdout: String(maybeError.stdout ?? ""),
      stderr: String(maybeError.stderr ?? ""),
      exitCode: typeof maybeError.code === "number" ? maybeError.code : 1,
    });
  }
}
