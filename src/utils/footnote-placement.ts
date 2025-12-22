const CODE_FENCE_REGEX = /^\s*(```|~~~)/;

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
