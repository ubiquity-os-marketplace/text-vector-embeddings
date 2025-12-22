import markdownit from "markdown-it";
import plainTextPlugin from "markdown-it-plain-text";
import { stripHtmlComments } from "../../utils/markdown-comments";

/**
 * Converts a Markdown string to plain text.
 * @param markdown
 * @returns
 */
export function markdownToPlainText(markdown: string | null): string | null {
  if (!markdown) {
    return markdown;
  }
  const sanitized = stripHtmlComments(markdown);
  const md = markdownit();
  md.use(plainTextPlugin);
  md.render(sanitized);
  //Package markdown-it-plain-text does not have types
  return (md as any).plainText;
}
