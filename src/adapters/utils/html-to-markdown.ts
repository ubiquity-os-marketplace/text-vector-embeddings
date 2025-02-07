import markdownit from "markdown-it";
import html2md from "html-to-md";

/**
 * Converts a HTML string to Markdown.
 * @param html
 * @returns The Markdown string
 */
export function htmlToMarkdown(html: string | null): string | null {
  if (!html) {
    return html;
  }

  // Convert markdown to html, to prevent syntax issues with html2md
  const md = markdownit({ html: true });
  const renderedHtml = md.render(html);

  // Convert html to markdown
  return html2md(renderedHtml);
}
