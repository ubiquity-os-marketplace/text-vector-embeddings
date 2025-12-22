export type DocumentType = "issue" | "issue_comment" | "review_comment" | "pull_request";

export type IssueDocumentType = "issue" | "pull_request";
export type CommentDocumentType = "issue_comment" | "review_comment";

export const ISSUE_DOCUMENT_TYPES: IssueDocumentType[] = ["issue", "pull_request"];
export const COMMENT_DOCUMENT_TYPES: CommentDocumentType[] = ["issue_comment", "review_comment"];
export const EMBEDDABLE_DOCUMENT_TYPES: DocumentType[] = ["issue", "issue_comment", "review_comment"];
