#!/usr/bin/env node

import "dotenv/config";
import type { PermissionMode } from "../permissions/permissions.js";

const VERSION = "0.1.0";

async function main(): Promise<void> {
  const startupStartedAt = performance.now();

  if (process.argv.includes("--version") || process.argv.includes("-v")) {
    console.log(`kk-agent v${VERSION}`);
    process.exit(0);
  }

  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(`kk-agent v${VERSION}

Terminal-native agentic coding system.

Usage:
  kk-agent [--model <model>] [--permission-mode <default|plan|auto>] [--agent-teams]
  kk-agent --resume [session-id]
  kk-agent --dump-system-prompt
  kk-agent --version
  kk-agent --help

Commands inside the app:
  /help      Show local command help
  /clear     Clear the current conversation
  /compact   Compress conversation context, optionally with a focus
  /cost      Show total token usage for this session
  /history   Show recent saved sessions for this project
  /resume    Resume latest or selected saved session
  /rewind    Preview or restore files to an earlier conversation turn
  /mcp       Show MCP server status and tools
  /agents    List built-in and custom SubAgents
  /teams     Show current Agent Team status
  /hooks     Show lifecycle hook status
  /config    Show or edit merged settings
  /output-style
             Show or change the active output style
  /commands  Show user-defined slash commands
  /mode      Show or change permission mode
  /model     Show or change the active model
  /exit      Exit the app
  /quit      Exit the app

Keys:
  Ctrl+C     Interrupt current request, or exit when idle
  Ctrl+D     Exit the app`);
    process.exit(0);
  }

  const modelIndex = process.argv.indexOf("--model");
  const model = modelIndex !== -1 ? process.argv[modelIndex + 1] : undefined;
  const resumeIndex = process.argv.indexOf("--resume");
  const resumeValue =
    resumeIndex !== -1 ? process.argv[resumeIndex + 1] : undefined;
  const shouldResume = resumeIndex !== -1;
  const resumeSessionId =
    shouldResume && resumeValue && !resumeValue.startsWith("--")
      ? resumeValue
      : undefined;
  const permissionModeIndex = process.argv.indexOf("--permission-mode");
  const permissionModeValue =
    permissionModeIndex !== -1 ? process.argv[permissionModeIndex + 1] : undefined;

  if (
    permissionModeValue !== undefined &&
    !["default", "plan", "auto"].includes(permissionModeValue)
  ) {
    console.error("Fatal: --permission-mode must be default, plan, or auto.");
    process.exit(1);
  }
  const permissionMode = permissionModeValue as PermissionMode | undefined;
  const flagSettings: Record<string, unknown> = {};
  if (model) {
    flagSettings.model = model;
  }
  if (permissionMode) {
    flagSettings.mode = permissionMode;
  }
  if (process.argv.includes("--agent-teams")) {
    flagSettings.agentTeams = { enabled: true };
  }
  const { setFlagSettings, loadSettings, isProjectTrusted } =
    await import("../config/index.js");
  setFlagSettings(flagSettings);

  if (process.argv.includes("--dump-system-prompt")) {
    const { buildSystemPrompt } = await import("../context/systemPrompt.js");
    const { bootstrapSkills } = await import("../services/skills/bootstrap.js");
    const { bootstrapAgents } = await import("../agents/bootstrap.js");
    const {
      bootstrapOutputStyles,
      bootstrapUserCommands,
    } = await import("../services/extensions/index.js");
    await bootstrapOutputStyles({ cwd: process.cwd() });
    await bootstrapUserCommands({ cwd: process.cwd() });
    await bootstrapSkills({ cwd: process.cwd() });
    await bootstrapAgents({ cwd: process.cwd() });
    console.log(await buildSystemPrompt({ cwd: process.cwd() }));
    process.exit(0);
  }

  const React = await import("react");
  const { render } = await import("ink");
  const { App } = await import("../ui/App.js");
  const { DEFAULT_MODEL } = await import("../services/api/anthropic.js");
  const { restoreSession } = await import("../session/transcript.js");
  const { cleanupOldFileHistoryBackups } = await import("../session/fileHistory.js");
  const { bootstrapMcp } = await import("../services/mcp/bootstrap.js");
  const { bootstrapSkills } = await import("../services/skills/bootstrap.js");
  const { bootstrapAgents } = await import("../agents/bootstrap.js");
  const {
    bootstrapOutputStyles,
    bootstrapUserCommands,
  } = await import("../services/extensions/index.js");
  const trusted = await isProjectTrusted({ cwd: process.cwd() });
  const loadedSettings = await loadSettings({
    cwd: process.cwd(),
    includeUntrustedProject: trusted,
  });

  const settingsModel =
    typeof loadedSettings.settings.model === "string"
      ? loadedSettings.settings.model
      : undefined;
  const settingsPermissionMode =
    loadedSettings.settings.mode === "default" ||
    loadedSettings.settings.mode === "plan" ||
    loadedSettings.settings.mode === "auto"
      ? loadedSettings.settings.mode as PermissionMode
      : undefined;
  const resolvedModel = model ?? settingsModel ?? DEFAULT_MODEL;
  await cleanupOldFileHistoryBackups({
    cleanupPeriodDays: typeof loadedSettings.settings.cleanupPeriodDays === "number"
      ? loadedSettings.settings.cleanupPeriodDays
      : undefined,
  });
  const restored = shouldResume
    ? await restoreSession({
        cwd: process.cwd(),
        sessionId: resumeSessionId,
      })
    : null;

  const styleResult = await bootstrapOutputStyles({ cwd: process.cwd() });
  for (const warning of styleResult.warnings) {
    console.error(warning);
  }
  const commandResult = await bootstrapUserCommands({ cwd: process.cwd() });
  for (const warning of commandResult.warnings) {
    console.error(warning);
  }

  const skillsResult = await bootstrapSkills({ cwd: process.cwd() });
  for (const warning of skillsResult.warnings) {
    console.error(warning);
  }
  const agentsResult = await bootstrapAgents({ cwd: process.cwd() });
  for (const warning of agentsResult.warnings) {
    console.error(warning);
  }

  void bootstrapMcp(process.cwd()).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`MCP bootstrap failed: ${message}`);
  });

  const { waitUntilExit } = render(
    React.createElement(App, {
      model: resolvedModel,
      version: VERSION,
      startupDurationMs: performance.now() - startupStartedAt,
      permissionMode: permissionMode ?? settingsPermissionMode,
      initialMessages: restored?.messages,
      initialUsage: restored?.summary.totalUsage,
      sessionId: restored?.summary.sessionId,
      sessionStartedAt: restored?.summary.startedAt,
      sessionAlreadyInitialized: restored !== null,
      initialFileHistorySnapshots: restored?.fileHistorySnapshots,
    }),
    { exitOnCtrlC: false },
  );

  await waitUntilExit();
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Fatal: ${message}`);
  process.exit(1);
});
