export const TEAM_LEAD_NAME = "team-lead";

export interface TeamMember {
  agentId: string;
  name: string;
  agentType?: string;
  joinedAt: number;
  isActive: boolean;
  outputFile?: string;
  worktreePath?: string;
  worktreeBranch?: string;
  gitRoot?: string;
}

export interface TeamFile {
  name: string;
  description?: string;
  createdAt: number;
  leadAgentId: string;
  members: TeamMember[];
}

export interface TeamContext {
  teamName: string;
  leadAgentId: string;
  teamFilePath: string;
  createdAt: number;
}

export interface TeammateIdentity {
  agentId: string;
  agentName: string;
  teamName: string;
}

export interface TeammateMessage {
  from: string;
  text: string;
  timestamp: string;
  read: boolean;
  summary?: string;
}
