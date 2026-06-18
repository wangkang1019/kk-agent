import { mkdir, readFile, stat, writeFile, rename } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type SettingSource = "user" | "project" | "local" | "flag" | "policy";

export interface LoadedSettingSource {
  source: SettingSource;
  path: string | null;
  raw: Record<string, unknown> | null;
  exists: boolean;
  parseError?: string;
  validationErrors: string[];
}

export interface LoadedSettings {
  settings: Record<string, unknown>;
  origins: Record<string, SettingSource>;
  sources: LoadedSettingSource[];
  warnings: string[];
}

export interface LoadSettingSourcesParams {
  cwd: string;
  homeDir?: string;
  includeUntrustedProject?: boolean;
}

export type SettingWriteScope = "user" | "project" | "local";

const SETTING_SOURCE_ORDER: readonly SettingSource[] = [
  "user",
  "project",
  "local",
  "flag",
  "policy",
] as const;

const ARRAY_FIELDS = new Set([
  "allow",
  "deny",
  "ask",
  "additionalDirectories",
  "claudeMdExcludes",
  "enabledMcpjsonServers",
  "disabledMcpjsonServers",
]);

const OBJECT_FIELDS = new Set([
  "agentTeams",
  "env",
  "hooks",
  "mcpServers",
  "permissions",
  "sandbox",
]);

const STRING_ARRAY_FIELDS = new Set([...ARRAY_FIELDS]);
const BOOLEAN_FIELDS = new Set([
  "agentTeamsEnabled",
  "disableAllHooks",
  "enableAllProjectMcpServers",
  "hooksEnabled",
  "prefersReducedMotion",
  "respectGitignore",
  "syntaxHighlightingDisabled",
]);
const STRING_FIELDS = new Set([
  "apiKeyHelper",
  "language",
  "model",
  "outputStyle",
  "statusLine",
]);
const NUMBER_FIELDS = new Set(["cleanupPeriodDays"]);

const RISKY_PROJECT_KEYS = new Set([
  "additionalDirectories",
  "allow",
  "ask",
  "deny",
  "disableAllHooks",
  "enableAllProjectMcpServers",
  "enabledMcpjsonServers",
  "disabledMcpjsonServers",
  "env",
  "hooks",
  "hooksEnabled",
  "mcpServers",
  "sandbox",
  "statusLine",
]);

let flagSettings: Record<string, unknown> = {};
const settingsCache = new Map<string, {
  signature: string;
  sources: LoadedSettingSource[];
}>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function deepMerge(
  base: Record<string, unknown>,
  next: Record<string, unknown>,
): Record<string, unknown> {
  const out = { ...base };

  for (const [key, value] of Object.entries(next)) {
    if (isRecord(value) && isRecord(out[key])) {
      out[key] = deepMerge(out[key], value);
    } else {
      out[key] = value;
    }
  }

  return out;
}

function normalizePath(filePath: string): string {
  return path.resolve(filePath);
}

export function getAgentHome(homeDir = os.homedir()): string {
  return path.join(homeDir, ".kk-agent");
}

export function getUserSettingsPath(homeDir = os.homedir()): string {
  return path.join(getAgentHome(homeDir), "settings.json");
}

export function getProjectSettingsPath(cwd: string): string {
  return path.join(path.resolve(cwd), ".kk-agent", "settings.json");
}

export function getLocalSettingsPath(cwd: string): string {
  return path.join(path.resolve(cwd), ".kk-agent", "settings.local.json");
}

export function getPolicySettingsPath(homeDir = os.homedir()): string {
  return process.env.KK_AGENT_MANAGED_SETTINGS ??
    path.join(getAgentHome(homeDir), "managed-settings.json");
}

export function setFlagSettings(next: Record<string, unknown>): void {
  flagSettings = { ...next };
  resetSettingsCache();
}

export function resetSettingsCache(): void {
  settingsCache.clear();
}

async function fileSignature(filePath: string): Promise<string> {
  try {
    const info = await stat(filePath);
    return `${info.mtimeMs}:${info.size}`;
  } catch {
    return "missing";
  }
}

async function readJsonFile(filePath: string): Promise<{
  raw: unknown;
  exists: boolean;
  parseError?: string;
}> {
  try {
    return {
      raw: JSON.parse(await readFile(filePath, "utf8")) as unknown,
      exists: true,
    };
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return { raw: null, exists: false };
    }

    return {
      raw: null,
      exists: true,
      parseError: error instanceof Error ? error.message : String(error),
    };
  }
}

function normalizeStringArray(
  raw: Record<string, unknown>,
  key: string,
  errors: string[],
): void {
  if (!(key in raw)) {
    return;
  }

  if (!Array.isArray(raw[key])) {
    delete raw[key];
    errors.push(`ignored invalid field "${key}": expected string[]`);
    return;
  }

  raw[key] = (raw[key] as unknown[])
    .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    .map((item) => item.trim());
}

export function validateSettingsObject(
  value: unknown,
  label: string,
): { value: Record<string, unknown> | null; errors: string[] } {
  if (value === null || value === undefined) {
    return { value: null, errors: [] };
  }

  if (!isRecord(value)) {
    return { value: null, errors: [`${label}: settings must be an object`] };
  }

  const candidate = { ...value };
  const errors: string[] = [];

  for (const key of STRING_ARRAY_FIELDS) {
    normalizeStringArray(candidate, key, errors);
  }

  for (const key of STRING_FIELDS) {
    if (key in candidate && typeof candidate[key] !== "string") {
      delete candidate[key];
      errors.push(`ignored invalid field "${key}": expected string`);
    }
  }

  for (const key of BOOLEAN_FIELDS) {
    if (key in candidate && typeof candidate[key] !== "boolean") {
      delete candidate[key];
      errors.push(`ignored invalid field "${key}": expected boolean`);
    }
  }

  for (const key of NUMBER_FIELDS) {
    if (
      key in candidate &&
      (typeof candidate[key] !== "number" || !Number.isFinite(candidate[key]))
    ) {
      delete candidate[key];
      errors.push(`ignored invalid field "${key}": expected number`);
    }
  }

  if (
    candidate.mode !== undefined &&
    candidate.mode !== "default" &&
    candidate.mode !== "plan" &&
    candidate.mode !== "auto"
  ) {
    delete candidate.mode;
    errors.push('ignored invalid field "mode": expected default|plan|auto');
  }

  for (const key of OBJECT_FIELDS) {
    if (key in candidate && !isRecord(candidate[key])) {
      delete candidate[key];
      errors.push(`ignored invalid field "${key}": expected object`);
    }
  }

  return {
    value: candidate,
    errors: errors.map((error) => `${label}: ${error}`),
  };
}

function stripUntrustedProjectKeys(
  raw: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!raw) {
    return null;
  }

  const out = { ...raw };
  for (const key of RISKY_PROJECT_KEYS) {
    delete out[key];
  }

  if (out.mode === "auto") {
    delete out.mode;
  }

  return out;
}

async function buildSource(
  source: SettingSource,
  filePath: string | null,
  raw: unknown,
  exists: boolean,
  parseError: string | undefined,
  includeUntrustedProject: boolean,
): Promise<LoadedSettingSource> {
  const validated = validateSettingsObject(raw, source);
  const shouldFilter =
    !includeUntrustedProject && (source === "project" || source === "local");
  const filtered = shouldFilter
    ? stripUntrustedProjectKeys(validated.value)
    : validated.value;

  return {
    source,
    path: filePath,
    raw: filtered,
    exists,
    ...(parseError && { parseError }),
    validationErrors: validated.errors,
  };
}

export async function loadSettingSources(
  params: LoadSettingSourcesParams,
): Promise<LoadedSettingSource[]> {
  const cwd = path.resolve(params.cwd);
  const homeDir = params.homeDir ?? os.homedir();
  const includeUntrustedProject = params.includeUntrustedProject ?? true;
  const files = {
    user: getUserSettingsPath(homeDir),
    project: getProjectSettingsPath(cwd),
    local: getLocalSettingsPath(cwd),
    policy: getPolicySettingsPath(homeDir),
  };
  const signatureParts = await Promise.all([
    fileSignature(files.user),
    fileSignature(files.project),
    fileSignature(files.local),
    fileSignature(files.policy),
  ]);
  const signature = [
    ...signatureParts,
    JSON.stringify(flagSettings),
    String(includeUntrustedProject),
  ].join("|");
  const cacheKey = `${normalizePath(cwd)}:${homeDir}:${includeUntrustedProject}`;
  const cached = settingsCache.get(cacheKey);

  if (cached?.signature === signature) {
    return cached.sources;
  }

  const [user, project, local, policy] = await Promise.all([
    readJsonFile(files.user),
    readJsonFile(files.project),
    readJsonFile(files.local),
    readJsonFile(files.policy),
  ]);
  const sources = await Promise.all([
    buildSource("user", files.user, user.raw, user.exists, user.parseError, true),
    buildSource(
      "project",
      files.project,
      project.raw,
      project.exists,
      project.parseError,
      includeUntrustedProject,
    ),
    buildSource(
      "local",
      files.local,
      local.raw,
      local.exists,
      local.parseError,
      includeUntrustedProject,
    ),
    buildSource("flag", null, flagSettings, true, undefined, true),
    buildSource("policy", files.policy, policy.raw, policy.exists, policy.parseError, true),
  ]);

  settingsCache.set(cacheKey, { signature, sources });
  return sources;
}

function sourceCanUseSensitive(source: SettingSource): boolean {
  return source === "user" || source === "flag" || source === "policy";
}

function shouldSkipSensitive(
  key: string,
  value: unknown,
  source: SettingSource,
): boolean {
  return key === "mode" && value === "auto" && !sourceCanUseSensitive(source);
}

export function mergeSettingSources(
  sources: LoadedSettingSource[],
): LoadedSettings {
  const settings: Record<string, unknown> = {};
  const origins: Record<string, SettingSource> = {};

  for (const sourceName of SETTING_SOURCE_ORDER) {
    const source = sources.find((item) => item.source === sourceName);
    if (!source?.raw) {
      continue;
    }

    for (const [key, value] of Object.entries(source.raw)) {
      if (shouldSkipSensitive(key, value, source.source)) {
        continue;
      }

      if (ARRAY_FIELDS.has(key)) {
        settings[key] = unique([
          ...((settings[key] as string[] | undefined) ?? []),
          ...(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []),
        ]);
      } else if (OBJECT_FIELDS.has(key) && isRecord(value)) {
        settings[key] = deepMerge(
          isRecord(settings[key]) ? settings[key] as Record<string, unknown> : {},
          value,
        );
      } else {
        settings[key] = value;
      }

      origins[key] = source.source;
    }
  }

  const warnings = sources.flatMap((source) => [
    ...(source.parseError ? [`${source.source}: ${source.parseError}`] : []),
    ...source.validationErrors,
  ]);

  return { settings, origins, sources, warnings };
}

export async function loadSettings(
  params: LoadSettingSourcesParams,
): Promise<LoadedSettings> {
  return mergeSettingSources(await loadSettingSources(params));
}

export function getPathValue(
  value: Record<string, unknown>,
  dottedKey: string,
): unknown {
  return dottedKey
    .split(".")
    .filter(Boolean)
    .reduce<unknown>((acc, key) => {
      return isRecord(acc) ? acc[key] : undefined;
    }, value);
}

function setPathValue(
  target: Record<string, unknown>,
  dottedKey: string,
  value: unknown,
): void {
  const parts = dottedKey.split(".").filter(Boolean);
  let cursor = target;

  for (const part of parts.slice(0, -1)) {
    if (!isRecord(cursor[part])) {
      cursor[part] = {};
    }
    cursor = cursor[part] as Record<string, unknown>;
  }

  const last = parts.at(-1);
  if (!last) {
    return;
  }

  if (value === undefined) {
    delete cursor[last];
  } else {
    cursor[last] = value;
  }
}

async function readJsonObject(filePath: string): Promise<Record<string, unknown>> {
  const read = await readJsonFile(filePath);
  return isRecord(read.raw) ? read.raw : {};
}

export async function writeJsonAtomic(
  filePath: string,
  value: unknown,
): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmpPath, filePath);
}

async function ensureLocalSettingsIgnored(cwd: string): Promise<void> {
  const gitignorePath = path.join(path.resolve(cwd), ".gitignore");
  const line = ".kk-agent/settings.local.json";
  let content = "";

  try {
    content = await readFile(gitignorePath, "utf8");
  } catch {
    // Missing .gitignore is fine; create one with the local settings rule.
  }

  if (content.split(/\r?\n/).includes(line)) {
    return;
  }

  const separator = content && !content.endsWith("\n") ? "\n" : "";
  await writeFile(gitignorePath, `${content}${separator}${line}\n`, "utf8");
}

export async function writeSetting(params: {
  cwd: string;
  scope: SettingWriteScope;
  key: string;
  value: unknown;
  homeDir?: string;
}): Promise<void> {
  const filePath = params.scope === "user"
    ? getUserSettingsPath(params.homeDir)
    : params.scope === "project"
      ? getProjectSettingsPath(params.cwd)
      : getLocalSettingsPath(params.cwd);
  const existing = await readJsonObject(filePath);
  setPathValue(existing, params.key, params.value);
  await writeJsonAtomic(filePath, existing);

  if (params.scope === "local") {
    await ensureLocalSettingsIgnored(params.cwd);
  }

  resetSettingsCache();
}

export function parseConfigValue(raw: string | undefined): unknown {
  if (raw === undefined) {
    return undefined;
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

export function formatConfigValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value);
}
