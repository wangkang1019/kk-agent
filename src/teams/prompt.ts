import { getActiveTeam } from "../state/teamContext.js";
import { isAgentTeamsEnabled } from "./featureFlag.js";
import { readTeamFile } from "./teamHelpers.js";
import { TEAM_LEAD_NAME } from "./types.js";

export async function formatTeamSystemReminder(): Promise<string> {
  if (!isAgentTeamsEnabled()) {
    return "";
  }

  const activeTeam = getActiveTeam();
  if (!activeTeam) {
    return [
      "<system-reminder>",
      "Agent Teams is enabled. Use TeamCreate when a task benefits from named long-running teammates that can coordinate through SendMessage.",
      "After creating a team, spawn teammates with Agent({ name, team_name, run_in_background: true, prompt, description }).",
      "</system-reminder>",
    ].join("\n");
  }

  const file = await readTeamFile(activeTeam.teamName);
  const members = file?.members ?? [];
  const teammates = members.filter((member) => member.name !== TEAM_LEAD_NAME);
  const roster = teammates.length > 0
    ? teammates.map((member) => {
      const details = [
        `${member.name} [${member.isActive ? "active" : "idle"}]`,
        member.agentType ? `type=${member.agentType}` : "",
        member.outputFile ? `output=${member.outputFile}` : "",
        member.worktreePath ? `worktree=${member.worktreePath}` : "",
      ].filter(Boolean).join(" | ");
      return `- ${details}`;
    })
    : ["- (No teammates yet.)"];

  return [
    "<system-reminder>",
    `Agent Teams: you are the lead of team "${activeTeam.teamName}".`,
    file?.description ? `Description: ${file.description}` : "",
    "Team members:",
    ...roster,
    "",
    "Use Agent({ name, team_name, run_in_background: true, prompt, description }) to spawn named teammates.",
    "Use SendMessage({ to, message, summary }) to coordinate. Use to=\"*\" for broadcast.",
    "Use TeamDelete only after all teammates are idle.",
    "</system-reminder>",
  ].filter(Boolean).join("\n");
}
