import pkg from "../../package.json" with { type: "json" };

const HTML_COMMENT_REGEX = /<!--[\s\S]*?-->/g;
const CODE_FENCE_REGEX = /^\s*(```|~~~)/;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const UPDATE_COMMENT_REGEX = new RegExp(`<!--\\s*${escapeRegExp(pkg.name)}\\s+update\\s+[^\\n]*?-->`, "g");

export function buildPluginUpdateComment(timestamp: string): string {
  return `<!-- ${pkg.name} update ${timestamp} -->`;
}

export function appendPluginUpdateComment(markdown: string, comment: string): string {
  const { cleaned } = stripPluginUpdateComments(markdown);
  const trimmed = cleaned.trimEnd();
  const separator = trimmed.length === 0 ? "" : "\n\n";
  return `${trimmed}${separator}${comment}`;
}

export function normalizeWhitespace(markdown: string): string {
  return markdown
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function stripPluginUpdateComments(markdown: string): {
  cleaned: string;
  latestComment: string | null;
  matchCount: number;
} {
  if (!markdown) {
    return { cleaned: markdown ?? "", latestComment: null, matchCount: 0 };
  }

  const matches = Array.from(markdown.matchAll(UPDATE_COMMENT_REGEX));
  UPDATE_COMMENT_REGEX.lastIndex = 0;
  const latestComment = matches.length > 0 ? matches[matches.length - 1][0] : null;

  const lines = markdown.split(/\r?\n/);
  const output: string[] = [];
  let shouldRemoveNextBlank = false;

  for (const line of lines) {
    const hasComment = line.match(UPDATE_COMMENT_REGEX);
    UPDATE_COMMENT_REGEX.lastIndex = 0;
    const trimmedLine = line.trimStart();
    const isCommentAtLineStart = trimmedLine.startsWith("<!--");

    if (!hasComment) {
      if (shouldRemoveNextBlank && line.trim() === "") {
        shouldRemoveNextBlank = false;
        continue;
      }
      shouldRemoveNextBlank = false;
      output.push(line.replace(/[ \t]+$/, ""));
      continue;
    }

    let cleanedLine = line.replace(UPDATE_COMMENT_REGEX, "");
    UPDATE_COMMENT_REGEX.lastIndex = 0;

    if (isCommentAtLineStart) {
      cleanedLine = cleanedLine.replace(/^\s+/, "");
    }
    cleanedLine = cleanedLine.replace(/[ \t]+$/, "");

    if (cleanedLine.trim() === "") {
      while (output.length > 0 && output[output.length - 1].trim() === "") {
        output.pop();
      }
      shouldRemoveNextBlank = true;
      continue;
    }

    if (shouldRemoveNextBlank && cleanedLine.trim() === "") {
      shouldRemoveNextBlank = false;
      continue;
    }

    shouldRemoveNextBlank = false;
    output.push(cleanedLine);
  }

  return { cleaned: output.join("\n"), latestComment, matchCount: matches.length };
}

export function stripHtmlComments(markdown: string): string {
  if (!markdown) {
    return markdown;
  }

  const lines = markdown.split(/\r?\n/);
  let isInFence = false;
  let fenceToken = "";
  let buffer: string[] = [];
  const output: string[] = [];

  const flushBuffer = (preserveComments: boolean) => {
    if (buffer.length === 0) {
      return;
    }
    const chunk = buffer.join("\n");
    output.push(preserveComments ? chunk : chunk.replace(HTML_COMMENT_REGEX, ""));
    buffer = [];
  };

  for (const line of lines) {
    const fenceMatch = line.match(CODE_FENCE_REGEX);
    if (fenceMatch) {
      const fence = fenceMatch[1];
      if (!isInFence) {
        flushBuffer(false);
        isInFence = true;
        fenceToken = fence;
        buffer.push(line);
      } else if (fence === fenceToken) {
        buffer.push(line);
        flushBuffer(true);
        isInFence = false;
        fenceToken = "";
      } else {
        buffer.push(line);
      }
      continue;
    }
    buffer.push(line);
  }

  flushBuffer(isInFence);

  return output.join("\n");
}
