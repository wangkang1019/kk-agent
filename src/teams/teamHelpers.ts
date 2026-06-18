import {
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { TeamFile, TeamMember } from "./types.js";

let teamsRootOverride: string | null = null;

export function setTeamsRootForTesting(root: string | null): void {
  teamsRootOverride = root;
}

export function getTeamsRoot(): string {
  return teamsRootOverride ?? path.join(os.homedir(), ".kk-agent", "teams");
}

export function sanitizeTeamName(name: string): string {
  const sanitized = String(name)
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();

  return sanitized || "team";
}

export function sanitizeMemberName(name: string): string {
  return sanitizeTeamName(name);
}

export function formatAgentId(name: string, teamName: string): string {
  return `${sanitizeMemberName(name)}@${sanitizeTeamName(teamName)}`;
}

export function getTeamDir(teamName: string): string {
  return path.join(getTeamsRoot(), sanitizeTeamName(teamName));
}

export function getTeamFilePath(teamName: string): string {
  return path.join(getTeamDir(teamName), "team.json");
}

export async function readTeamFile(teamName: string): Promise<TeamFile | null> {
  try {
    const parsed = JSON.parse(await readFile(getTeamFilePath(teamName), "utf8"));
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const value = parsed as TeamFile;
    return Array.isArray(value.members) ? value : null;
  } catch {
    return null;
  }
}

export async function writeTeamFile(
  teamName: string,
  file: TeamFile,
): Promise<void> {
  await mkdir(getTeamDir(teamName), { recursive: true });
  await writeFile(
    getTeamFilePath(teamName),
    `${JSON.stringify(file, null, 2)}\n`,
    "utf8",
  );
}

export async function cleanupTeamDirectory(teamName: string): Promise<void> {
  await rm(getTeamDir(teamName), { recursive: true, force: true });
}

export async function addTeamMember(
  teamName: string,
  member: TeamMember,
): Promise<TeamFile | null> {
  const file = await readTeamFile(teamName);
  if (!file) {
    return null;
  }

  const memberName = sanitizeMemberName(member.name);
  const next: TeamFile = {
    ...file,
    members: [
      ...file.members.filter((item) => item.name !== memberName),
      { ...member, name: memberName },
    ],
  };
  await writeTeamFile(teamName, next);
  return next;
}

export async function setMemberActive(
  teamName: string,
  memberName: string,
  isActive: boolean,
): Promise<TeamFile | null> {
  const file = await readTeamFile(teamName);
  if (!file) {
    return null;
  }

  const sanitizedName = sanitizeMemberName(memberName);
  const next: TeamFile = {
    ...file,
    members: file.members.map((member) => {
      return member.name === sanitizedName
        ? { ...member, isActive }
        : member;
    }),
  };
  await writeTeamFile(teamName, next);
  return next;
}
