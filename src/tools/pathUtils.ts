import { homedir } from "node:os";
import path from "node:path";

export function expandHome(filePath: string): string {
  if (filePath === "~") {
    return homedir();
  }

  if (filePath.startsWith(`~${path.sep}`) || filePath.startsWith("~/")) {
    return path.join(homedir(), filePath.slice(2));
  }

  return filePath;
}

export function isInsideCwd(targetPath: string, cwd: string): boolean {
  const root = path.resolve(cwd);
  const target = path.resolve(targetPath);
  const relative = path.relative(root, target);

  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function resolveWorkspacePath(
  filePath: string,
  cwd: string,
  allowedRoots: string[] = [],
): string {
  const expanded = expandHome(filePath);
  const resolved = path.resolve(cwd, expanded);

  const isAllowedExternalPath = allowedRoots.some((root) => {
    return isInsideCwd(resolved, root);
  });

  if (!isInsideCwd(resolved, cwd) && !isAllowedExternalPath) {
    throw new Error(`Path is outside the workspace: ${filePath}`);
  }

  return resolved;
}
