import os from "node:os";

import {
  isProjectTrusted,
  loadSettingSources,
  writeSetting,
} from "../config/index.js";
import type { SandboxSettings } from "./types.js";

export const DEFAULT_SANDBOX_SETTINGS: SandboxSettings = {
  enabled: false,
  autoAllowBashIfSandboxed: true,
  allowUnsandboxedCommands: true,
  excludedCommands: [],
  filesystem: {
    allowRead: [],
    denyRead: [],
    allowWrite: [],
    denyWrite: [],
  },
  network: {
    allow: true,
    allowedDomains: [],
    deniedDomains: [],
  },
};

export interface LoadSandboxSettingsParams {
  cwd: string;
  homeDir?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((item): item is string => typeof item === "string");
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function mergeBoolean(
  current: boolean,
  next: unknown,
): boolean {
  return typeof next === "boolean" ? next : current;
}

function mergeSandboxSettings(
  base: SandboxSettings,
  raw: unknown,
): SandboxSettings {
  if (!isRecord(raw)) {
    return base;
  }

  const filesystem = isRecord(raw.filesystem) ? raw.filesystem : {};
  const network = isRecord(raw.network) ? raw.network : {};

  return {
    enabled: mergeBoolean(base.enabled, raw.enabled),
    autoAllowBashIfSandboxed: mergeBoolean(
      base.autoAllowBashIfSandboxed,
      raw.autoAllowBashIfSandboxed,
    ),
    allowUnsandboxedCommands: mergeBoolean(
      base.allowUnsandboxedCommands,
      raw.allowUnsandboxedCommands,
    ),
    excludedCommands: unique([
      ...base.excludedCommands,
      ...stringArray(raw.excludedCommands),
    ]),
    filesystem: {
      allowRead: unique([
        ...base.filesystem.allowRead,
        ...stringArray(filesystem.allowRead),
      ]),
      denyRead: unique([
        ...base.filesystem.denyRead,
        ...stringArray(filesystem.denyRead),
      ]),
      allowWrite: unique([
        ...base.filesystem.allowWrite,
        ...stringArray(filesystem.allowWrite),
      ]),
      denyWrite: unique([
        ...base.filesystem.denyWrite,
        ...stringArray(filesystem.denyWrite),
      ]),
    },
    network: {
      allow: mergeBoolean(base.network.allow, network.allow),
      allowedDomains: unique([
        ...base.network.allowedDomains,
        ...stringArray(network.allowedDomains),
      ]),
      deniedDomains: unique([
        ...base.network.deniedDomains,
        ...stringArray(network.deniedDomains),
      ]),
    },
  };
}

export async function loadSandboxSettings(
  params: LoadSandboxSettingsParams,
): Promise<SandboxSettings> {
  const trusted = await isProjectTrusted({
    cwd: params.cwd,
    homeDir: params.homeDir,
  });
  const sources = await loadSettingSources({
    cwd: params.cwd,
    homeDir: params.homeDir ?? os.homedir(),
    includeUntrustedProject: trusted,
  });
  let settings = DEFAULT_SANDBOX_SETTINGS;

  for (const source of sources) {
    settings = mergeSandboxSettings(settings, source.raw?.sandbox);
  }

  return settings;
}

export async function writeProjectSandboxSettings(params: {
  cwd: string;
  patch: Partial<Pick<
    SandboxSettings,
    "enabled" | "allowUnsandboxedCommands" | "autoAllowBashIfSandboxed"
  >>;
}): Promise<void> {
  for (const [key, value] of Object.entries(params.patch)) {
    await writeSetting({
      cwd: params.cwd,
      scope: "project",
      key: `sandbox.${key}`,
      value,
    });
  }
}

export function normalizeSandboxSettings(raw: unknown): SandboxSettings {
  return mergeSandboxSettings(DEFAULT_SANDBOX_SETTINGS, raw);
}
