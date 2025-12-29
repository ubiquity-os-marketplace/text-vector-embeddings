export type DocumentType = "issue" | "issue_comment" | "review_comment" | "pull_request" | "pull_request_review";

export type IssueDocumentType = "issue" | "pull_request";
export type CommentDocumentType = "issue_comment" | "review_comment" | "pull_request_review";

export const ISSUE_DOCUMENT_TYPES: IssueDocumentType[] = ["issue", "pull_request"];
export const COMMENT_DOCUMENT_TYPES: CommentDocumentType[] = ["issue_comment", "review_comment", "pull_request_review"];
export const EMBEDDABLE_DOCUMENT_TYPES: DocumentType[] = ["issue", "pull_request", "issue_comment", "review_comment", "pull_request_review"];
