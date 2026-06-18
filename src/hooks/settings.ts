import os from "node:os";
import path from "node:path";

import {
  isProjectTrusted,
  loadSettingSources,
  loadSettings,
} from "../config/index.js";
import {
  HOOK_EVENTS,
  type HookCommand,
  type HookEvent,
  type HookMatcherGroup,
  type HookShell,
  type HooksSettings,
} from "./types.js";

const DEFAULT_TIMEOUT_SEC = 60;

export interface LoadHooksSettingsParams {
  cwd: string;
  homeDir?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHookEvent(value: string): value is HookEvent {
  return (HOOK_EVENTS as readonly string[]).includes(value);
}

function normalizeShell(value: unknown): HookShell | undefined {
  if (
    value === "powershell" ||
    value === "cmd" ||
    value === "bash" ||
    value === "sh"
  ) {
    return value;
  }

  return undefined;
}

function normalizeHookCommand(raw: unknown): HookCommand | null {
  if (!isRecord(raw)) {
    return null;
  }

  const type = typeof raw.type === "string" ? raw.type : "command";
  if (type !== "command") {
    return null;
  }

  if (typeof raw.command !== "string" || !raw.command.trim()) {
    return null;
  }

  const timeout =
    typeof raw.timeout === "number" && Number.isFinite(raw.timeout) && raw.timeout > 0
      ? raw.timeout
      : DEFAULT_TIMEOUT_SEC;
  const shell = normalizeShell(raw.shell);

  return {
    type: "command",
    command: raw.command,
    timeout,
    ...(shell && { shell }),
  };
}

function normalizeMatcherGroup(raw: unknown): HookMatcherGroup | null {
  if (!isRecord(raw) || !Array.isArray(raw.hooks)) {
    return null;
  }

  const hooks = raw.hooks.map(normalizeHookCommand).filter(Boolean) as HookCommand[];

  if (hooks.length === 0) {
    return null;
  }

  return {
    ...(typeof raw.matcher === "string" && raw.matcher.trim() && {
      matcher: raw.matcher.trim(),
    }),
    hooks,
  };
}

function normalizeHooksBlock(rawHooks: unknown): HooksSettings {
  const settings: HooksSettings = {};

  if (!isRecord(rawHooks)) {
    return settings;
  }

  for (const [event, rawGroups] of Object.entries(rawHooks)) {
    if (!isHookEvent(event) || !Array.isArray(rawGroups)) {
      continue;
    }

    const groups = rawGroups
      .map(normalizeMatcherGroup)
      .filter(Boolean) as HookMatcherGroup[];

    if (groups.length > 0) {
      settings[event] = groups;
    }
  }

  return settings;
}

function resolveHooksEnabled(settings: Record<string, unknown>): boolean {
  if (typeof settings.disableAllHooks === "boolean") {
    return !settings.disableAllHooks;
  }

  return typeof settings.hooksEnabled === "boolean"
    ? settings.hooksEnabled
    : true;
}

export function matcherFires(
  matcher: string | undefined,
  matchField: string | undefined,
): boolean {
  if (!matcher || matcher === "*") {
    return true;
  }

  if (!matchField) {
    return true;
  }

  if (!/[*.?+()[\]{}|^$\\]/.test(matcher)) {
    return matcher === matchField;
  }

  try {
    return new RegExp(`^(?:${matcher})$`).test(matchField);
  } catch {
    return false;
  }
}

export function findMatchingHooks(
  settings: HooksSettings,
  event: HookEvent,
  matchField?: string,
): HookCommand[] {
  const groups = settings[event] ?? [];
  return groups.flatMap((group) =>
    matcherFires(group.matcher, matchField) ? group.hooks : []
  );
}

export async function loadHooksSettings(
  params: LoadHooksSettingsParams,
): Promise<HooksSettings> {
  if (process.env.KK_AGENT_DISABLE_HOOKS === "1") {
    return {};
  }

  const trusted = await isProjectTrusted({
    cwd: params.cwd,
    homeDir: params.homeDir,
  });
  const sources = await loadSettingSources({
    cwd: params.cwd,
    homeDir: params.homeDir ?? os.homedir(),
    includeUntrustedProject: trusted,
  });
  const loaded = await loadSettings({
    cwd: params.cwd,
    homeDir: params.homeDir ?? os.homedir(),
    includeUntrustedProject: trusted,
  });

  if (!resolveHooksEnabled(loaded.settings)) {
    return {};
  }

  const merged: HooksSettings = {};

  for (const source of sources) {
    const hooks = normalizeHooksBlock(source.raw?.hooks);
    for (const event of HOOK_EVENTS) {
      const groups = hooks[event] ?? [];
      if (groups.length > 0) {
        merged[event] = [...(merged[event] ?? []), ...groups];
      }
    }
  }

  return merged;
}

export async function formatHooksStatus(params: LoadHooksSettingsParams): Promise<string> {
  const disabled = process.env.KK_AGENT_DISABLE_HOOKS === "1";
  const homeDir = params.homeDir ?? os.homedir();
  const cwd = path.resolve(params.cwd);
  const trusted = await isProjectTrusted({ cwd, homeDir });
  const loaded = await loadSettings({
    cwd,
    homeDir,
    includeUntrustedProject: trusted,
  });
  const enabledBySettings = resolveHooksEnabled(loaded.settings);
  const settings = await loadHooksSettings(params);
  const lines = [
    "Hooks",
    "",
    `enabled: ${!disabled && enabledBySettings}`,
    `settings enabled: ${enabledBySettings}`,
    `env disabled: ${disabled}`,
    `project trusted: ${trusted}`,
    `user settings: ${path.join(homeDir, ".kk-agent", "settings.json")}`,
    `project settings: ${path.join(cwd, ".kk-agent", "settings.json")}`,
    "",
  ];

  for (const event of HOOK_EVENTS) {
    const groups = settings[event] ?? [];
    if (groups.length > 0) {
      const hookCount = groups.reduce((count, group) => count + group.hooks.length, 0);
      lines.push(`${event}: ${groups.length} group${groups.length === 1 ? "" : "s"}, ${hookCount} hook${hookCount === 1 ? "" : "s"}`);
    }
  }

  if (lines.at(-1) === "") {
    lines.push("No hooks configured.");
  }

  return lines.join("\n");
}
