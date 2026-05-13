const FOOTNOTE_ID_REGEX = /\[\^([A-Za-z][A-Za-z0-9-]*-)?(\d+)\^\]/g;

export function createFootnoteId(prefix: string, index: number): string {
  return `${prefix}-${index.toString().padStart(2, "0")}`;
}

export function createFootnoteRef(prefix: string, index: number): string {
  return `[^${createFootnoteId(prefix, index)}^]`;
}

export function getHighestFootnoteIndex(content: string, prefix?: string): number {
  let highestIndex = 0;
  for (const match of content.matchAll(FOOTNOTE_ID_REGEX)) {
    const [, foundPrefix, rawIndex] = match;
    if (prefix && foundPrefix && foundPrefix !== `${prefix}-`) {
      continue;
    }
    highestIndex = Math.max(highestIndex, Number.parseInt(rawIndex, 10));
  }
  return highestIndex;
}
