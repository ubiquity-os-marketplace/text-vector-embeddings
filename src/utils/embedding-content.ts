import { stripHtmlComments } from "./markdown-comments";

export const MIN_ISSUE_MARKDOWN_LENGTH = 32;
export const MIN_COMMENT_MARKDOWN_LENGTH = 64;

export function cleanMarkdown(markdown: string | null): string {
  if (!markdown) {
    return "";
  }
  return stripHtmlComments(markdown).trim();
}

export function isTooShort(content: string, minLength: number): boolean {
  return content.length < minLength;
}
