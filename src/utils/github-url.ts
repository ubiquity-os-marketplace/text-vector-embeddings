export function normalizeGitHubIssueUrl(url: string): string {
  return url.split("#")[0].replace("https://github.com", "https://www.github.com");
}

export function normalizeGitHubCommentUrl(url: string): string {
  return url.replace("https://github.com", "https://www.github.com");
}
