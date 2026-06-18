import { rm } from "node:fs/promises";

import { git } from "../agents/worktree.js";
import { getActiveTeam, setActiveTeam, clearActiveTeam } from "../state/teamContext.js";
import {
  TEAM_LEAD_NAME,
  cleanupTeamDirectory,
  formatAgentId,
  getTeamFilePath,
  isAgentTeamsEnabled,
  readTeamFile,
  sanitizeMemberName,
  sanitizeTeamName,
  writeTeamFile,
  writeToMailbox,
} from "../teams/index.js";
import type { TeamMember } from "../teams/types.js";
import type { Tool, ToolContext, ToolResult } from "./Tool.js";

function asString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === "string" ? value.trim() : "";
}

function senderName(context: ToolContext): string {
  return context.teammateIdentity?.agentName ?? TEAM_LEAD_NAME;
}

async function cleanupMemberWorktree(member: TeamMember): Promise<string | null> {
  if (!member.worktreePath || !member.worktreeBranch || !member.gitRoot) {
    return null;
  }

  const status = await git(["status", "--porcelain"], member.worktreePath);
  if (status.code !== 0 || status.stdout.trim()) {
    return `Preserved dirty worktree for ${member.name}: ${member.worktreePath} (${member.worktreeBranch})`;
  }

  const remove = await git(["worktree", "remove", "--force", member.worktreePath], member.gitRoot);
  const branch = await git(["branch", "-D", member.worktreeBranch], member.gitRoot);
  const errors = [remove, branch]
    .filter((result) => result.code !== 0)
    .map((result) => result.stderr.trim())
    .filter(Boolean);

  if (errors.length > 0) {
    return `Could not remove worktree for ${member.name}: ${errors.join("; ")}`;
  }

  await rm(member.worktreePath, { recursive: true, force: true }).catch(() => {});
  return null;
}

export const teamCreateTool: Tool = {
  name: "TeamCreate",
  description: "Create one active Agent Team so named teammates can coordinate through SendMessage.",
  inputSchema: {
    type: "object",
    properties: {
      team_name: { type: "string", description: "Team name." },
      description: { type: "string", description: "Optional purpose of this team." },
    },
    required: ["team_name"],
    additionalProperties: false,
  },
  async call(input: Record<string, unknown>): Promise<ToolResult> {
    if (!isAgentTeamsEnabled()) {
      return { content: "Error: Agent Teams is not enabled.", isError: true };
    }

    const rawName = asString(input, "team_name");
    const description = asString(input, "description");
    if (!rawName) {
      return { content: "Error: team_name is required.", isError: true };
    }

    const teamName = sanitizeTeamName(rawName);
    const active = getActiveTeam();
    if (active) {
      return { content: `Error: already leading team "${active.teamName}".`, isError: true };
    }

    if (await readTeamFile(teamName)) {
      return {
        content: `Error: team already exists on disk: ${getTeamFilePath(teamName)}. Delete it first with TeamDelete or choose another team_name.`,
        isError: true,
      };
    }

    const createdAt = Date.now();
    const leadAgentId = formatAgentId(TEAM_LEAD_NAME, teamName);
    const teamFile = {
      name: teamName,
      ...(description && { description }),
      createdAt,
      leadAgentId,
      members: [
        {
          agentId: leadAgentId,
          name: TEAM_LEAD_NAME,
          agentType: "team-lead",
          joinedAt: createdAt,
          isActive: true,
        },
      ],
    };

    await writeTeamFile(teamName, teamFile);
    setActiveTeam({
      teamName,
      leadAgentId,
      teamFilePath: getTeamFilePath(teamName),
      createdAt,
    });

    return {
      content: [
        `Team "${teamName}" created.`,
        `team_file: ${getTeamFilePath(teamName)}`,
        "Spawn teammates with Agent({ name, team_name, run_in_background: true, prompt, description }).",
        "Coordinate with SendMessage({ to, message, summary }).",
      ].join("\n"),
    };
  },
  isReadOnly(): boolean {
    return false;
  },
  isEnabled(): boolean {
    return isAgentTeamsEnabled();
  },
  isConcurrencySafe(): boolean {
    return false;
  },
};

export const sendMessageTool: Tool = {
  name: "SendMessage",
  description: "Send a message to a teammate inbox, or broadcast to all active teammates with to='*'.",
  inputSchema: {
    type: "object",
    properties: {
      to: { type: "string", description: "Recipient teammate name, or * for broadcast." },
      message: { type: "string", description: "Message body." },
      summary: { type: "string", description: "Optional one-line summary." },
    },
    required: ["to", "message"],
    additionalProperties: false,
  },
  async call(input: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    if (!isAgentTeamsEnabled()) {
      return { content: "Error: Agent Teams is not enabled.", isError: true };
    }

    const active = getActiveTeam();
    if (!active) {
      return { content: "Error: no active team.", isError: true };
    }

    const to = asString(input, "to");
    const message = typeof input.message === "string" ? input.message : "";
    const summary = asString(input, "summary");

    if (!to || !message.trim()) {
      return { content: "Error: to and message are required.", isError: true };
    }

    const file = await readTeamFile(active.teamName);
    if (!file) {
      return { content: "Error: active team file is missing.", isError: true };
    }

    const from = senderName(context);
    const timestamp = new Date().toISOString();
    const mailboxMessage = {
      from,
      text: message,
      timestamp,
      ...(summary && { summary }),
    };

    if (to === "*") {
      const recipients = file.members.filter((member) => {
        return member.isActive && member.name !== from;
      });

      for (const recipient of recipients) {
        await writeToMailbox(recipient.name, active.teamName, mailboxMessage);
      }

      return {
        content: `Broadcast message to ${recipients.map((member) => member.name).join(", ") || "(none)"}.`,
      };
    }

    const recipientName = sanitizeMemberName(to);
    if (recipientName === from) {
      return { content: "Error: cannot SendMessage to yourself.", isError: true };
    }

    const recipient = file.members.find((member) => member.name === recipientName);
    if (!recipient) {
      return {
        content: `Error: no teammate named ${recipientName}. Known: ${file.members.map((member) => member.name).join(", ")}`,
        isError: true,
      };
    }

    await writeToMailbox(recipient.name, active.teamName, mailboxMessage);
    return { content: `Message delivered to "${recipient.name}" in team "${active.teamName}".` };
  },
  isReadOnly(): boolean {
    return false;
  },
  isEnabled(): boolean {
    return isAgentTeamsEnabled();
  },
  isConcurrencySafe(): boolean {
    return true;
  },
};

export const teamDeleteTool: Tool = {
  name: "TeamDelete",
  description: "Disband the current Agent Team after all teammates have finished.",
  inputSchema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  async call(): Promise<ToolResult> {
    if (!isAgentTeamsEnabled()) {
      return { content: "Error: Agent Teams is not enabled.", isError: true };
    }

    const active = getActiveTeam();
    if (!active) {
      return { content: "Error: no team is active.", isError: true };
    }

    const file = await readTeamFile(active.teamName);
    if (!file) {
      clearActiveTeam();
      return { content: "Team file was missing. Cleared active team." };
    }

    const activeTeammates = file.members.filter((member) => {
      return member.name !== TEAM_LEAD_NAME && member.isActive;
    });

    if (activeTeammates.length > 0) {
      return {
        content: `Error: cannot delete team while teammates are active: ${activeTeammates.map((member) => member.name).join(", ")}`,
        isError: true,
      };
    }

    const warnings = (await Promise.all(
      file.members.map((member) => cleanupMemberWorktree(member)),
    )).filter((warning): warning is string => Boolean(warning));

    await cleanupTeamDirectory(active.teamName);
    clearActiveTeam();

    return {
      content: [
        `Team "${active.teamName}" disbanded.`,
        ...warnings,
      ].join("\n"),
    };
  },
  isReadOnly(): boolean {
    return false;
  },
  isEnabled(): boolean {
    return isAgentTeamsEnabled();
  },
  isConcurrencySafe(): boolean {
    return false;
  },
};
