import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  isProjectTrusted,
  loadSettingSources,
} from "../../config/index.js";
import type {
  McpConfigScope,
  McpHttpServerConfig,
  McpServerConfig,
  McpSseServerConfig,
  McpStdioServerConfig,
  ScopedMcpServerConfig,
} from "../../types/mcp.js";

interface RawMcpSettings {
  mcpServers?: unknown;
}

export interface LoadMcpConfigsParams {
  cwd: string;
  homeDir?: string;
}

export interface McpConfigLoadResult {
  servers: Record<string, ScopedMcpServerConfig>;
  errors: string[];
}

export function validateMcpServerConfig(
  name: string,
  raw: unknown,
  scope: McpConfigScope,
): { ok: true; value: McpServerConfig } | { ok: false; error: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: `mcpServers.${name} (${scope}) must be an object` };
  }

  const obj = raw as Record<string, unknown>;
  const type = obj.type;

  if (type !== undefined && type !== "stdio" && type !== "http" && type !== "sse") {
    return {
      ok: false,
      error: `mcpServers.${name} (${scope}): unsupported transport '${String(type)}'. Use stdio/http/sse.`,
    };
  }

  if (type === "http" || type === "sse") {
    return validateRemoteConfig(name, obj, scope, type);
  }

  return validateStdioConfig(name, obj, scope);
}

function validateStdioConfig(
  name: string,
  obj: Record<string, unknown>,
  scope: McpConfigScope,
): { ok: true; value: McpStdioServerConfig } | { ok: false; error: string } {
  if (typeof obj.command !== "string" || obj.command.trim().length === 0) {
    return {
      ok: false,
      error: `mcpServers.${name} (${scope}): command is required`,
    };
  }

  if (obj.args !== undefined) {
    if (!Array.isArray(obj.args) || obj.args.some((item) => typeof item !== "string")) {
      return {
        ok: false,
        error: `mcpServers.${name} (${scope}): args must be an array of strings`,
      };
    }
  }

  const env = validateStringMap(obj.env, `mcpServers.${name} (${scope}): env`);
  if (!env.ok) {
    return { ok: false, error: env.error };
  }

  return {
    ok: true,
    value: {
      type: "stdio",
      command: obj.command,
      args: Array.isArray(obj.args) ? obj.args : [],
      ...(env.value && { env: env.value }),
    },
  };
}

function validateRemoteConfig(
  name: string,
  obj: Record<string, unknown>,
  scope: McpConfigScope,
  type: "http" | "sse",
): { ok: true; value: McpHttpServerConfig | McpSseServerConfig } | { ok: false; error: string } {
  if (typeof obj.url !== "string" || obj.url.trim().length === 0) {
    return {
      ok: false,
      error: `mcpServers.${name} (${scope}): url is required`,
    };
  }

  try {
    new URL(obj.url);
  } catch {
    return {
      ok: false,
      error: `mcpServers.${name} (${scope}): url is not a valid URL`,
    };
  }

  const headers = validateStringMap(obj.headers, `mcpServers.${name} (${scope}): headers`);
  if (!headers.ok) {
    return { ok: false, error: headers.error };
  }

  return {
    ok: true,
    value: {
      type,
      url: obj.url,
      ...(headers.value && { headers: headers.value }),
    },
  };
}

function validateStringMap(
  value: unknown,
  label: string,
): { ok: true; value?: Record<string, string> } | { ok: false; error: string } {
  if (value === undefined) {
    return { ok: true };
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: `${label} must be an object of strings` };
  }

  for (const [key, item] of Object.entries(value)) {
    if (typeof item !== "string") {
      return { ok: false, error: `${label}.${key} must be a string` };
    }
  }

  return { ok: true, value: value as Record<string, string> };
}

async function readSettings(filePath: string): Promise<{
  raw: RawMcpSettings | null;
  error?: string;
}> {
  try {
    const raw = await readFile(filePath, "utf8");
    return { raw: JSON.parse(raw) as RawMcpSettings };
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return { raw: null };
    }

    return {
      raw: null,
      error: `${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function extractServers(
  raw: RawMcpSettings | null,
  scope: McpConfigScope,
  errors: string[],
): Record<string, ScopedMcpServerConfig> {
  if (!raw?.mcpServers) {
    return {};
  }

  if (
    typeof raw.mcpServers !== "object" ||
    Array.isArray(raw.mcpServers)
  ) {
    errors.push(`mcpServers (${scope}) must be an object`);
    return {};
  }

  const servers: Record<string, ScopedMcpServerConfig> = {};

  for (const [name, config] of Object.entries(raw.mcpServers)) {
    const validated = validateMcpServerConfig(name, config, scope);
    if (!validated.ok) {
      errors.push(validated.error);
      continue;
    }

    servers[name] = { ...validated.value, scope } as ScopedMcpServerConfig;
  }

  return servers;
}

export async function loadMcpConfigs(
  params: LoadMcpConfigsParams,
): Promise<McpConfigLoadResult> {
  const homeDir = params.homeDir ?? os.homedir();
  const cwd = path.resolve(params.cwd);
  const trusted = await isProjectTrusted({ cwd, homeDir });
  const settingSources = await loadSettingSources({
    cwd,
    homeDir,
    includeUntrustedProject: trusted,
  });
  const sources: Array<{ path: string; scope: McpConfigScope }> = [
    { path: path.join(homeDir, ".kk-agent", "mcp.json"), scope: "user" },
    ...(trusted
      ? [{ path: path.join(cwd, ".kk-agent", "mcp.json"), scope: "project" as const }]
      : []),
  ];
  const loaded = await Promise.all(
    sources.map(async (source) => {
      return { ...source, result: await readSettings(source.path) };
    }),
  );
  const errors = [
    ...settingSources.flatMap((source) => [
      ...(source.parseError ? [`${source.path}: ${source.parseError}`] : []),
      ...source.validationErrors,
    ]),
    ...loaded.flatMap((source) => {
    return source.result.error ? [source.result.error] : [];
    }),
  ];
  const fromSettings = settingSources.reduce<Record<string, ScopedMcpServerConfig>>(
    (acc, source) => {
      const scope: McpConfigScope =
        source.source === "user" || source.source === "flag" || source.source === "policy"
          ? "user"
          : "project";
      return {
        ...acc,
        ...extractServers(source.raw, scope, errors),
      };
    },
    {},
  );
  const fromMcpJson = loaded.reduce<Record<string, ScopedMcpServerConfig>>(
    (acc, source) => {
      return {
        ...acc,
        ...extractServers(source.result.raw, source.scope, errors),
      };
    },
    {},
  );

  return {
    servers: {
      ...fromSettings,
      ...fromMcpJson,
    },
    errors,
  };
}
