import crypto from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Message } from "../types/message.js";

export const PLAN_ATTACHMENT_MARKER = "[plan_mode_attachment]";
export const PLAN_EXIT_MARKER = "[plan_mode_exit]";
export const TURNS_BETWEEN_PLAN_ATTACHMENTS = 5;

export interface PlanPathParams {
  homeDir?: string;
  sessionId?: string;
}

export interface AllowedPrompt {
  tool: string;
  prompt: string;
}

function agentHome(homeDir?: string): string {
  return path.join(homeDir ?? os.homedir(), ".kk-agent");
}

function sanitizeSlug(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80) || "plan";
}

export function getPlansDirectory(homeDir?: string): string {
  return path.join(agentHome(homeDir), "plans");
}

export function getPlanFilePath(params: PlanPathParams = {}): string {
  const slug = params.sessionId
    ? sanitizeSlug(params.sessionId)
    : crypto.randomBytes(4).toString("hex");

  return path.join(getPlansDirectory(params.homeDir), `${slug}.md`);
}

export async function ensurePlansDirectory(homeDir?: string): Promise<void> {
  await mkdir(getPlansDirectory(homeDir), { recursive: true });
}

export async function writePlan(params: {
  homeDir?: string;
  sessionId?: string;
  content: string;
}): Promise<string> {
  await ensurePlansDirectory(params.homeDir);
  const planPath = getPlanFilePath(params);
  await writeFile(planPath, params.content, "utf8");
  return planPath;
}

export async function readPlan(params: PlanPathParams = {}): Promise<string | null> {
  try {
    return await readFile(getPlanFilePath(params), "utf8");
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }

    throw error;
  }
}

export function buildAllowRulesFromPrompts(prompts: AllowedPrompt[]): string[] {
  return prompts
    .filter((item) => item.tool && item.prompt)
    .map((item) => {
      if (item.tool === "Bash") {
        return `Bash(${item.prompt} *)`;
      }

      return item.tool;
    });
}

export function buildFullPlanModeText(planFilePath: string): string {
  return [
    PLAN_ATTACHMENT_MARKER,
    "PLAN MODE ACTIVE - you are now in plan mode.",
    "",
    "Workflow:",
    "1. EXPLORE: Use Read, Grep, Glob, and read-only Bash commands to understand the task.",
    "2. PLAN: Write a concrete implementation plan to the plan file.",
    "3. EXIT: Call ExitPlanMode when the plan is ready for approval.",
    "",
    "Rules:",
    "- Do not edit source files yet.",
    "- Do not run shell commands that change local state.",
    "- Only the plan file may be written in plan mode.",
    "",
    `Plan file: ${planFilePath}`,
  ].join("\n");
}

export function buildSparsePlanModeText(planFilePath: string): string {
  return [
    PLAN_ATTACHMENT_MARKER,
    "Reminder: You are still in PLAN MODE. Only read-only tools are allowed.",
    `Write your plan to: ${planFilePath}`,
    "Call ExitPlanMode when your plan is ready.",
  ].join("\n");
}

export function isInternalPlanMessage(message: Message): boolean {
  if (typeof message.content !== "string") {
    return false;
  }

  return (
    message.content.startsWith(PLAN_ATTACHMENT_MARKER) ||
    message.content.startsWith(PLAN_EXIT_MARKER)
  );
}

function humanTurnsSinceLastAttachment(messages: Message[]): number {
  let turns = 0;

  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];

    if (
      message?.role === "user" &&
      typeof message.content === "string" &&
      message.content.startsWith(PLAN_ATTACHMENT_MARKER)
    ) {
      return turns;
    }

    if (
      message?.role === "user" &&
      typeof message.content === "string" &&
      !isInternalPlanMessage(message)
    ) {
      turns++;
    }
  }

  return turns;
}

function attachmentCount(messages: Message[]): number {
  return messages.filter((message) => {
    return (
      message.role === "user" &&
      typeof message.content === "string" &&
      message.content.startsWith(PLAN_ATTACHMENT_MARKER)
    );
  }).length;
}

export function getPlanModeAttachment(
  messages: Message[],
  planFilePath: string,
): Message | null {
  const existingAttachments = attachmentCount(messages);

  if (existingAttachments === 0) {
    return { role: "user", content: buildFullPlanModeText(planFilePath) };
  }

  if (humanTurnsSinceLastAttachment(messages) < TURNS_BETWEEN_PLAN_ATTACHMENTS) {
    return null;
  }

  const shouldUseFullReminder = (existingAttachments + 1) % 3 === 1;

  return {
    role: "user",
    content: shouldUseFullReminder
      ? buildFullPlanModeText(planFilePath)
      : buildSparsePlanModeText(planFilePath),
  };
}

export function buildPlanExitAttachment(planFilePath: string): Message {
  return {
    role: "user",
    content: [
      PLAN_EXIT_MARKER,
      "Plan mode has ended. Full tool access is restored according to the active permission mode.",
      `Approved plan file: ${planFilePath}`,
    ].join("\n"),
  };
}
