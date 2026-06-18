import { appendFile, mkdir, open } from "node:fs/promises";
import path from "node:path";

import { getSessionPaths } from "../session/transcript.js";

export type TaskOutputEvent =
  | { type: "started"; agentType: string; description?: string; prompt: string }
  | { type: "text"; text: string }
  | { type: "tool_use"; toolName: string }
  | { type: "tool_result"; toolName: string; isError: boolean; preview?: string }
  | {
      type: "turn_usage";
      inputTokens: number;
      outputTokens: number;
      totalTokens: number;
      turn?: number;
    }
  | {
      type: "completed";
      reason: string;
      finalText: string;
      durationMs: number;
      totalTokens: number;
      toolUseCount: number;
    }
  | { type: "failed"; error: string; durationMs: number };

function encodeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "-");
}

export function getTaskOutputPath(params: {
  cwd: string;
  sessionId: string;
  agentId: string;
  homeDir?: string;
}): string {
  const paths = getSessionPaths({
    cwd: params.cwd,
    sessionId: params.sessionId,
    homeDir: params.homeDir ?? process.env.KK_AGENT_HOME,
  });

  return path.join(
    paths.projectDir,
    "tasks",
    `${encodeSegment(params.agentId)}.output`,
  );
}

export async function ensureTaskOutputFile(params: {
  cwd: string;
  sessionId: string;
  agentId: string;
  homeDir?: string;
}): Promise<string> {
  const filePath = getTaskOutputPath(params);
  await mkdir(path.dirname(filePath), { recursive: true });
  const handle = await open(filePath, "a");
  await handle.close();
  return filePath;
}

export async function appendTaskOutput(
  filePath: string,
  event: TaskOutputEvent,
): Promise<void> {
  try {
    await appendFile(
      filePath,
      `${JSON.stringify({ timestamp: new Date().toISOString(), ...event })}\n`,
      "utf8",
    );
  } catch {
    // Background logs are diagnostic only; never fail the child agent lifecycle.
  }
}
