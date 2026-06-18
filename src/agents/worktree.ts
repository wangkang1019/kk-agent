import { execFile } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface WorktreeInfo {
  gitRoot: string;
  worktreePath: string;
  worktreeBranch: string;
  headCommit: string;
}

export async function git(args: string[], cwd: string): Promise<GitResult> {
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 16 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const maybe = error as {
      code?: unknown;
      stdout?: unknown;
      stderr?: unknown;
      message?: unknown;
    };

    return {
      code: typeof maybe.code === "number" ? maybe.code : 127,
      stdout: typeof maybe.stdout === "string" ? maybe.stdout : "",
      stderr: typeof maybe.stderr === "string"
        ? maybe.stderr
        : typeof maybe.message === "string"
          ? maybe.message
          : String(error),
    };
  }
}

export async function findGitRoot(cwd: string): Promise<string | null> {
  let current = path.resolve(cwd);

  for (let index = 0; index < 64; index++) {
    try {
      await stat(path.join(current, ".git"));
      return current;
    } catch {
      const parent = path.dirname(current);

      if (parent === current) {
        return null;
      }

      current = parent;
    }
  }

  return null;
}

export function flattenSlug(slug: string): string {
  return slug.replaceAll(/[^A-Za-z0-9._-]/g, "+");
}

export function worktreeBranchName(slug: string): string {
  return `worktree-${flattenSlug(slug)}`;
}

export function worktreePathFor(gitRoot: string, slug: string): string {
  return path.join(gitRoot, ".kk-agent", "worktrees", flattenSlug(slug));
}

export async function createAgentWorktree(
  slug: string,
  cwd: string,
): Promise<WorktreeInfo> {
  const gitRoot = await findGitRoot(cwd);

  if (!gitRoot) {
    throw new Error(`Cannot create worktree: not inside a git repository (${cwd}).`);
  }

  const head = await git(["rev-parse", "HEAD"], gitRoot);
  if (head.code !== 0) {
    throw new Error(`Cannot read HEAD: ${head.stderr}`);
  }

  const worktreePath = worktreePathFor(gitRoot, slug);
  const worktreeBranch = worktreeBranchName(slug);
  await mkdir(path.dirname(worktreePath), { recursive: true });

  const add = await git(
    ["worktree", "add", "-B", worktreeBranch, worktreePath, "HEAD"],
    gitRoot,
  );
  if (add.code !== 0) {
    throw new Error(`git worktree add failed: ${add.stderr}`);
  }

  return {
    gitRoot,
    worktreePath,
    worktreeBranch,
    headCommit: head.stdout.trim(),
  };
}

export async function hasWorktreeChanges(
  worktreePath: string,
  headCommit: string,
): Promise<boolean> {
  const status = await git(["status", "--porcelain"], worktreePath);

  if (status.code !== 0 || status.stdout.trim()) {
    return true;
  }

  const revList = await git(["rev-list", "--count", `${headCommit}..HEAD`], worktreePath);

  if (revList.code !== 0) {
    return true;
  }

  return Number.parseInt(revList.stdout.trim(), 10) > 0;
}

export async function removeAgentWorktree(
  info: WorktreeInfo,
): Promise<{ ok: boolean; error?: string }> {
  const remove = await git(["worktree", "remove", "--force", info.worktreePath], info.gitRoot);
  const branch = await git(["branch", "-D", info.worktreeBranch], info.gitRoot);
  const errors = [remove, branch]
    .filter((result) => result.code !== 0)
    .map((result) => result.stderr.trim())
    .filter(Boolean);

  return errors.length === 0
    ? { ok: true }
    : { ok: false, error: errors.join("; ") };
}

export async function cleanupWorktreeIfNeeded(
  info: WorktreeInfo | undefined,
): Promise<Pick<WorktreeInfo, "worktreePath" | "worktreeBranch"> | null> {
  if (!info) {
    return null;
  }

  const dirty = await hasWorktreeChanges(info.worktreePath, info.headCommit)
    .catch(() => true);

  if (dirty) {
    return {
      worktreePath: info.worktreePath,
      worktreeBranch: info.worktreeBranch,
    };
  }

  await removeAgentWorktree(info);
  return null;
}
