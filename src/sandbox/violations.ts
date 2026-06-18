const SANDBOX_FAILURE_PATTERNS = [
  /sandbox/i,
  /operation not permitted/i,
  /permission denied/i,
  /access is denied/i,
];

export function looksLikeSandboxFailure(stderr: string): boolean {
  return SANDBOX_FAILURE_PATTERNS.some((pattern) => pattern.test(stderr));
}

export function annotateStderrWithSandboxFailures(
  stderr: string,
  exitCode: number,
): string {
  if (exitCode === 0 || !stderr.trim() || !looksLikeSandboxFailure(stderr)) {
    return stderr;
  }

  return [
    stderr,
    "",
    "<sandbox_violations>",
    "The command may have failed because the sandbox blocked an operation. Prefer using allowed workspace paths or ask the user before disabling the sandbox.",
    "</sandbox_violations>",
  ].join("\n");
}
