import {
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";

import {
  getTeamDir,
  sanitizeMemberName,
  sanitizeTeamName,
} from "./teamHelpers.js";
import type { TeammateMessage } from "./types.js";

const LOCK_RETRIES = 30;
const LOCK_MIN_TIMEOUT_MS = 5;
const LOCK_MAX_TIMEOUT_MS = 100;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  let timeout = LOCK_MIN_TIMEOUT_MS;

  for (let attempt = 0; attempt <= LOCK_RETRIES; attempt += 1) {
    try {
      await mkdir(lockPath, { recursive: false });
      try {
        return await fn();
      } finally {
        await rm(lockPath, { recursive: true, force: true });
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" || attempt === LOCK_RETRIES) {
        throw error;
      }

      await sleep(timeout);
      timeout = Math.min(timeout * 2, LOCK_MAX_TIMEOUT_MS);
    }
  }

  throw new Error(`Failed to acquire lock: ${lockPath}`);
}

export function getInboxPath(agentName: string, teamName: string): string {
  return path.join(
    getTeamDir(sanitizeTeamName(teamName)),
    "inboxes",
    `${sanitizeMemberName(agentName)}.json`,
  );
}

function getInboxLockPath(agentName: string, teamName: string): string {
  return path.join(
    getTeamDir(sanitizeTeamName(teamName)),
    "inboxes",
    `${sanitizeMemberName(agentName)}.lock`,
  );
}

async function ensureInboxFile(
  agentName: string,
  teamName: string,
): Promise<string> {
  const inboxPath = getInboxPath(agentName, teamName);
  await mkdir(path.dirname(inboxPath), { recursive: true });

  try {
    await writeFile(inboxPath, "[]", { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error;
    }
  }

  return inboxPath;
}

function parseMailbox(raw: string): TeammateMessage[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((message): message is TeammateMessage => {
        return message &&
          typeof message === "object" &&
          typeof message.from === "string" &&
          typeof message.text === "string" &&
          typeof message.timestamp === "string";
      })
      : [];
  } catch {
    return [];
  }
}

export async function readMailbox(
  agentName: string,
  teamName: string,
): Promise<TeammateMessage[]> {
  try {
    return parseMailbox(await readFile(getInboxPath(agentName, teamName), "utf8"));
  } catch {
    return [];
  }
}

export async function writeToMailbox(
  recipientName: string,
  teamName: string,
  message: Omit<TeammateMessage, "read">,
): Promise<void> {
  const inboxPath = await ensureInboxFile(recipientName, teamName);
  await withLock(getInboxLockPath(recipientName, teamName), async () => {
    const current = parseMailbox(await readFile(inboxPath, "utf8"));
    current.push({ ...message, read: false });
    await writeFile(inboxPath, `${JSON.stringify(current, null, 2)}\n`, "utf8");
  });
}

export async function drainUnreadMessages(
  agentName: string,
  teamName: string,
): Promise<TeammateMessage[]> {
  const inboxPath = await ensureInboxFile(agentName, teamName);

  return withLock(getInboxLockPath(agentName, teamName), async () => {
    const current = parseMailbox(await readFile(inboxPath, "utf8"));
    const unread = current.filter((message) => !message.read);

    if (unread.length > 0) {
      await writeFile(
        inboxPath,
        `${JSON.stringify(current.map((message) => ({ ...message, read: true })), null, 2)}\n`,
        "utf8",
      );
    }

    return unread;
  });
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
}

export function formatMailboxAttachment(messages: TeammateMessage[]): string {
  if (messages.length === 0) {
    return "";
  }

  return [
    "<teammate-messages>",
    "The following message(s) were sent by other team members.",
    "",
    ...messages.map((message) => {
      const attrs = [
        `from="${escapeAttribute(message.from)}"`,
        `timestamp="${escapeAttribute(message.timestamp)}"`,
        ...(message.summary ? [`summary="${escapeAttribute(message.summary)}"`] : []),
      ].join(" ");
      return `<teammate-message ${attrs}>\n${message.text}\n</teammate-message>`;
    }),
    "</teammate-messages>",
  ].join("\n");
}
