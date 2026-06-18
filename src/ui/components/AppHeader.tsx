import os from "node:os";

import { Box, Text, useStdout } from "ink";
import type { ReactNode } from "react";

import type { PermissionMode } from "../../permissions/permissions.js";

export interface HeaderInfo {
  version: string;
  model: string;
  mode: PermissionMode;
  cwd: string;
  contextPercent: number | null;
  startupDurationMs?: number;
}

export interface HeaderLines {
  titleLine: string;
  modelLine: string;
  cwdLine: string;
  contactLine: string;
  helpLine: string;
  modelLabel: string;
  directoryLabel: string;
}

const CONTACT_LINE =
  "github.com/wangkang1019 · wangkang19971019@163.com / wangkang19971019@gmail.com";

function normalizePathForCompare(value: string): string {
  return value.replace(/\\/g, "/").toLowerCase();
}

export function formatPrettyCwd(cwd: string, homeDir = os.homedir()): string {
  const normalizedCwd = normalizePathForCompare(cwd);
  const normalizedHome = normalizePathForCompare(homeDir);

  if (normalizedCwd === normalizedHome) {
    return "~";
  }

  if (normalizedCwd.startsWith(`${normalizedHome}/`)) {
    return `~${cwd.slice(homeDir.length)}`;
  }

  return cwd;
}

export function truncateMiddle(value: string, maxLength: number): string {
  if (maxLength <= 1) {
    return value.slice(0, Math.max(0, maxLength));
  }

  if (value.length <= maxLength) {
    return value;
  }

  const ellipsis = "...";
  const available = maxLength - ellipsis.length;
  const left = Math.ceil(available * 0.38);
  const right = Math.max(1, available - left);
  return `${value.slice(0, left)}${ellipsis}${value.slice(-right)}`;
}

export function buildHeaderLines(
  info: HeaderInfo,
  columns = 100,
  homeDir = os.homedir(),
): HeaderLines {
  const detailWidth = Math.max(24, columns - 18);
  const context = info.contextPercent === null ? "--" : `${info.contextPercent}%`;
  const prettyCwd = truncateMiddle(
    formatPrettyCwd(info.cwd, homeDir),
    Math.max(20, detailWidth),
  );

  return {
    titleLine: `KK Agent v${info.version}`,
    modelLine: `${info.model} · ${info.mode} · context ${context}`,
    cwdLine: prettyCwd,
    contactLine: truncateMiddle(CONTACT_LINE, Math.max(32, detailWidth)),
    helpLine: "Ctrl+C interrupt · Ctrl+D exit · Shift+Tab mode · /help commands",
    modelLabel: `model:     ${info.model} ${info.mode}   /model to change`,
    directoryLabel: `directory: ${prettyCwd}`,
  };
}

export function Logo({ compact = false }: { compact?: boolean }): ReactNode {
  if (compact) {
    return (
      <Box flexDirection="column" marginRight={2}>
        <Text color="#f97316" bold>KK</Text>
        <Text color="#f97316" bold>AG</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginRight={3}>
      <Text color="#f97316" bold>{"██  ██"}</Text>
      <Text color="#f97316" bold>{"██ ██ "}</Text>
      <Text color="#f97316" bold>{"████  "}</Text>
      <Text color="#f97316" bold>{"██ ██ "}</Text>
      <Text color="#f97316" bold>{"██  ██"}</Text>
    </Box>
  );
}

export function AppHeaderBlock({
  info,
  columns = 100,
}: {
  info: HeaderInfo;
  columns?: number;
}): ReactNode {
  const compact = columns < 84;
  const lines = buildHeaderLines(info, columns);
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="gray"
      paddingX={1}
      paddingY={0}
      marginBottom={1}
    >
      <Box>
        {!compact && <Logo />}

        <Box flexDirection="column">
          <Text>
            <Text bold color="cyan">{">_ "}</Text>
            <Text bold color="cyan">{lines.titleLine}</Text>
          </Text>
          <Text>
            <Text dimColor>model:     </Text>
            <Text color="green">{info.model}</Text>
            <Text dimColor>{` ${info.mode}   /model to change`}</Text>
          </Text>
          <Text>
            <Text dimColor>directory: </Text>
            <Text dimColor>{lines.cwdLine}</Text>
          </Text>
          <Text>
            <Text dimColor>contact:   </Text>
            <Text dimColor>{lines.contactLine}</Text>
          </Text>
          <Text dimColor>{lines.helpLine}</Text>
        </Box>
      </Box>
    </Box>
  );
}

export function AppHeader(props: HeaderInfo): ReactNode {
  const { stdout } = useStdout();
  return <AppHeaderBlock info={props} columns={stdout?.columns ?? 100} />;
}
