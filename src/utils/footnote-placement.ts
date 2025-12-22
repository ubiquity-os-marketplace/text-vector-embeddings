import { normalizedSimilarity } from "./string-similarity";

const CODE_FENCE_REGEX = /^\s*(```|~~~)/;

function normalizeLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function stripListPrefix(value: string): string {
  return value.replace(/^\s*(?:[-*+]|(\d+\.))\s+/, "").trim();
}

export function insertFootnoteRefNearSentence(
  markdown: string,
  sentence: string,
  footnoteRef: string,
  minSimilarity = 0.6
): { updated: string; inserted: boolean } {
  if (!sentence.trim()) {
    return { updated: markdown, inserted: false };
  }

  const normalizedSentence = normalizeLine(stripListPrefix(sentence));
  if (!normalizedSentence) {
    return { updated: markdown, inserted: false };
  }

  const lines = markdown.split(/\r?\n/);
  let isInFence = false;
  let fenceToken = "";
  let bestIndex = -1;
  let bestScore = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = line.match(CODE_FENCE_REGEX);
    if (fenceMatch) {
      const fence = fenceMatch[1];
      if (!isInFence) {
        isInFence = true;
        fenceToken = fence;
      } else if (fence === fenceToken) {
        isInFence = false;
        fenceToken = "";
      }
      continue;
    }

    if (isInFence) {
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("<!--") || trimmed.includes(footnoteRef)) {
      continue;
    }

    const normalizedLine = normalizeLine(stripListPrefix(trimmed));
    if (!normalizedLine) {
      continue;
    }

    const score = normalizedSimilarity(normalizedSentence, normalizedLine);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }

  if (bestIndex >= 0 && bestScore >= minSimilarity) {
    const suffix = lines[bestIndex].endsWith(" ") ? "" : " ";
    lines[bestIndex] = `${lines[bestIndex]}${suffix}${footnoteRef}`;
    return { updated: lines.join("\n"), inserted: true };
  }

  return { updated: markdown, inserted: false };
}

export function appendFootnoteRefsToFirstLine(markdown: string, refs: string[]): string {
  if (refs.length === 0) {
    return markdown;
  }

  const lines = markdown.split(/\r?\n/);
  let isInFence = false;
  let fenceToken = "";

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fenceMatch = line.match(CODE_FENCE_REGEX);
    if (fenceMatch) {
      const fence = fenceMatch[1];
      if (!isInFence) {
        isInFence = true;
        fenceToken = fence;
      } else if (fence === fenceToken) {
        isInFence = false;
        fenceToken = "";
      }
      continue;
    }

    if (!isInFence && line.trim() !== "" && !line.trimStart().startsWith("<!--")) {
      const suffix = line.endsWith(" ") ? "" : " ";
      lines[index] = `${line}${suffix}${refs.join(" ")}`;
      return lines.join("\n");
    }
  }

  const trimmed = markdown.trimEnd();
  if (trimmed.length === 0) {
    return refs.join(" ");
  }
  return `${trimmed} ${refs.join(" ")}`;
}
