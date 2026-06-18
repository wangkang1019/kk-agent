const MARKDOWN_SIGNAL = /[`*_#>~|]|^\s*[-+]\s|\]\(|\d+\.\s/m;
const MAX_CACHE_SIZE = 500;

const markdownCache = new Map<string, string[]>();

export function splitStablePrefix(content: string): {
  stable: string;
  tail: string;
} {
  const fenceCount = content.match(/```/g)?.length ?? 0;

  if (fenceCount % 2 === 1) {
    const lastFence = content.lastIndexOf("```");
    return {
      stable: content.slice(0, lastFence),
      tail: content.slice(lastFence),
    };
  }

  const lastParagraphBreak = content.lastIndexOf("\n\n");

  if (lastParagraphBreak < 0) {
    return { stable: "", tail: content };
  }

  return {
    stable: content.slice(0, lastParagraphBreak),
    tail: content.slice(lastParagraphBreak + 2),
  };
}

export function hasMarkdownSyntax(content: string): boolean {
  return MARKDOWN_SIGNAL.test(content.slice(0, 500));
}

function remember(key: string, lines: string[]): string[] {
  markdownCache.set(key, lines);

  if (markdownCache.size > MAX_CACHE_SIZE) {
    const oldest = markdownCache.keys().next().value;
    if (oldest) {
      markdownCache.delete(oldest);
    }
  }

  return lines;
}

function renderMarkdownLine(line: string): string {
  if (/^#{1,6}\s+/.test(line)) {
    return line.replace(/^#{1,6}\s+/, "").toUpperCase();
  }

  if (/^\s*[-+]\s+/.test(line)) {
    return line.replace(/^(\s*)[-+]\s+/, "$1• ");
  }

  return line
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
}

export function markdownToAnsiLines(content: string): string[] {
  const cached = markdownCache.get(content);

  if (cached) {
    return cached;
  }

  if (!hasMarkdownSyntax(content)) {
    return remember(content, content.split(/\r?\n/));
  }

  const lines: string[] = [];
  let inFence = false;
  let language = "text";

  for (const rawLine of content.split(/\r?\n/)) {
    const fence = /^```([\w-]+)?/.exec(rawLine);

    if (fence) {
      inFence = !inFence;
      language = fence[1] ?? "text";
      lines.push(inFence ? `┌─ ${language}` : "└─");
      continue;
    }

    if (inFence) {
      lines.push(`│ ${rawLine}`);
      continue;
    }

    lines.push(renderMarkdownLine(rawLine));
  }

  return remember(content, lines);
}

export function streamingMarkdownToLines(content: string): string[] {
  const { stable, tail } = splitStablePrefix(content);
  const stableLines = stable ? markdownToAnsiLines(stable) : [];
  const tailLines = tail ? tail.split(/\r?\n/) : [];

  return [
    ...stableLines,
    ...(stableLines.length > 0 && tailLines.length > 0 ? [""] : []),
    ...tailLines,
  ];
}

export function clearMarkdownCacheForTesting(): void {
  markdownCache.clear();
}
