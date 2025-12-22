const FOOTNOTE_DEF_REGEX = /\[\^(\d+)\^\]: ⚠ \d+% possible duplicate - [^\n]+(\n|$)/g;

export function removeCautionMessages(content: string): string {
  const cautionRegex = />[!CAUTION]\n> This issue may be a duplicate of the following issues:\n((> - \[[^\]]+\]\([^)]+\)\n)+)/g;
  return content.replace(cautionRegex, "");
}

export function stripDuplicateFootnotes(content: string): string {
  const footnotes = content.match(FOOTNOTE_DEF_REGEX);
  let contentWithoutFootnotes = content.replace(FOOTNOTE_DEF_REGEX, "");
  if (footnotes) {
    footnotes.forEach((footnote) => {
      const footnoteNumber = footnote.match(/\d+/)?.[0];
      if (!footnoteNumber) {
        return;
      }
      contentWithoutFootnotes = contentWithoutFootnotes.replace(new RegExp(`\\[\\^${footnoteNumber}\\^\\]`, "g"), "");
    });
  }
  return removeCautionMessages(contentWithoutFootnotes);
}
