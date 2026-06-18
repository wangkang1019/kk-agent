import os from "node:os";
import path from "node:path";

import type {
  SandboxProfile,
  SandboxSettings,
} from "./types.js";

export interface BuildSandboxProfileParams {
  cwd: string;
  settings: SandboxSettings;
  homeDir?: string;
}

function resolvePath(cwd: string, value: string): string {
  if (value.startsWith("~")) {
    return path.join(os.homedir(), value.slice(1));
  }

  return path.isAbsolute(value) ? path.resolve(value) : path.resolve(cwd, value);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function buildSandboxProfile(
  params: BuildSandboxProfileParams,
): SandboxProfile {
  const cwd = path.resolve(params.cwd);
  const homeDir = params.homeDir ?? os.homedir();

  return {
    filesystem: {
      allowRead: unique([
        cwd,
        ...params.settings.filesystem.allowRead.map((entry) => resolvePath(cwd, entry)),
      ]),
      denyRead: unique([
        ...params.settings.filesystem.denyRead.map((entry) => resolvePath(cwd, entry)),
      ]),
      allowWrite: unique([
        cwd,
        os.tmpdir(),
        ...params.settings.filesystem.allowWrite.map((entry) => resolvePath(cwd, entry)),
      ]),
      denyWrite: unique([
        path.join(homeDir, ".kk-agent", "settings.json"),
        path.join(homeDir, ".kk-agent", "skills"),
        path.join(cwd, ".kk-agent", "settings.json"),
        path.join(cwd, ".kk-agent", "skills"),
        ...params.settings.filesystem.denyWrite.map((entry) => resolvePath(cwd, entry)),
      ]),
    },
    network: params.settings.network,
  };
}

function escapeSbpl(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

function literalRule(paths: string[]): string {
  return paths.map((entry) => `"${escapeSbpl(entry)}"`).join(" ");
}

export function compileMacosSandboxProfile(profile: SandboxProfile): string {
  const lines = [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow sysctl*)",
    "(allow signal)",
    "(allow file-read*)",
  ];

  if (profile.filesystem.denyRead.length > 0) {
    lines.push(
      `(deny file-read* (subpath ${literalRule(profile.filesystem.denyRead)}))`,
    );
  }

  if (profile.filesystem.allowWrite.length > 0) {
    lines.push(
      `(allow file-write* (subpath ${literalRule(profile.filesystem.allowWrite)}))`,
    );
  }

  if (profile.filesystem.denyWrite.length > 0) {
    lines.push(
      `(deny file-write* (subpath ${literalRule(profile.filesystem.denyWrite)}))`,
    );
  }

  if (profile.network.allow) {
    lines.push("(allow network*)");
  } else {
    lines.push("(deny network*)");
  }

  return lines.join("\n");
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
