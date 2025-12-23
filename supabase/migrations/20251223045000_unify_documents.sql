CREATE EXTENSION IF NOT EXISTS vector;
SET search_path TO public, extensions;

CREATE TABLE IF NOT EXISTS documents (
    id varchar PRIMARY KEY,
    doc_type text NOT NULL,
    parent_id varchar,
    embedding vector(1024),
    payload jsonb,
    author_id varchar NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    modified_at timestamptz NOT NULL DEFAULT now(),
    markdown text,
    deleted_at timestamptz,
    embedding_status text NOT NULL DEFAULT 'ready'::text,
    embedding_model text,
    embedding_dim integer,
    CONSTRAINT documents_doc_type_check CHECK (doc_type IN ('issue', 'issue_comment', 'review_comment', 'pull_request')),
    CONSTRAINT documents_parent_id_fkey FOREIGN KEY (parent_id) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS documents_embedding_ivfflat
  ON public.documents USING ivfflat (embedding vector_cosine_ops)
  WITH (lists='10');

CREATE INDEX IF NOT EXISTS documents_doc_type_idx ON public.documents (doc_type);
CREATE INDEX IF NOT EXISTS documents_parent_id_idx ON public.documents (parent_id);

INSERT INTO documents (
    id,
    doc_type,
    parent_id,
    embedding,
    payload,
    author_id,
    created_at,
    modified_at,
    markdown,
    deleted_at,
    embedding_status,
    embedding_model,
    embedding_dim
)
SELECT
    id,
    CASE
        WHEN payload ? 'pull_request' AND NOT (payload ? 'issue') THEN 'pull_request'
        ELSE 'issue'
    END,
    NULL,
    embedding,
    payload,
    author_id,
    created_at,
    modified_at,
    markdown,
    deleted_at,
    embedding_status,
    embedding_model,
    embedding_dim
FROM issues
ON CONFLICT (id) DO NOTHING;

INSERT INTO documents (
    id,
    doc_type,
    parent_id,
    embedding,
    payload,
    author_id,
    created_at,
    modified_at,
    markdown,
    deleted_at,
    embedding_status,
    embedding_model,
    embedding_dim
)
SELECT
    id,
    CASE
        WHEN payload ? 'issue' THEN 'issue_comment'
        WHEN payload ? 'pull_request' THEN 'review_comment'
        ELSE 'issue_comment'
    END,
    issue_id,
    embedding,
    payload,
    author_id,
    created_at,
    modified_at,
    markdown,
    deleted_at,
    embedding_status,
    embedding_model,
    embedding_dim
FROM issue_comments
ON CONFLICT (id) DO NOTHING;

DROP VIEW IF EXISTS memory_messages;

CREATE VIEW memory_messages AS
SELECT
    'issue'::text AS source_type,
    documents.id AS source_id,
    (documents.payload -> 'repository'::text) ->> 'name'::text AS repo,
    ((documents.payload -> 'repository'::text) -> 'owner'::text) ->> 'login'::text AS owner,
    COALESCE(
      (documents.payload -> 'issue'::text) ->> 'html_url'::text,
      (documents.payload -> 'pull_request'::text) ->> 'html_url'::text
    ) AS source_url,
    COALESCE(
      (documents.payload -> 'issue'::text) ->> 'number'::text,
      (documents.payload -> 'pull_request'::text) ->> 'number'::text
    ) AS issue_number,
    documents.author_id,
    documents.markdown,
    documents.embedding,
    documents.created_at,
    documents.modified_at
FROM documents
WHERE documents.deleted_at IS NULL
  AND documents.embedding_status = 'ready'::text
  AND documents.embedding IS NOT NULL
  AND documents.doc_type IN ('issue', 'pull_request')
UNION ALL
SELECT
    'issue_comment'::text AS source_type,
    documents.id AS source_id,
    (documents.payload -> 'repository'::text) ->> 'name'::text AS repo,
    ((documents.payload -> 'repository'::text) -> 'owner'::text) ->> 'login'::text AS owner,
    (documents.payload -> 'comment'::text) ->> 'html_url'::text AS source_url,
    COALESCE(
      (documents.payload -> 'issue'::text) ->> 'number'::text,
      (documents.payload -> 'pull_request'::text) ->> 'number'::text
    ) AS issue_number,
    documents.author_id,
    documents.markdown,
    documents.embedding,
    documents.created_at,
    documents.modified_at
FROM documents
WHERE documents.deleted_at IS NULL
  AND documents.embedding_status = 'ready'::text
  AND documents.embedding IS NOT NULL
  AND documents.doc_type IN ('issue_comment', 'review_comment');

DROP FUNCTION IF EXISTS find_similar_issues(VARCHAR, vector(1024), float8, INT);
DROP FUNCTION IF EXISTS find_similar_comments(vector(1024), float8, INT);
DROP FUNCTION IF EXISTS find_similar_issues_annotate(VARCHAR, vector(1024), float8, INT);
DROP FUNCTION IF EXISTS find_similar_comments_annotate(VARCHAR, vector(1024), float8, INT);
DROP FUNCTION IF EXISTS find_similar_issues_to_match(VARCHAR, vector(1024), float8, INT);

CREATE OR REPLACE FUNCTION find_similar_issues(current_id VARCHAR, query_embedding vector(1024), threshold float8, top_k INT)
RETURNS TABLE(issue_id VARCHAR, similarity float8) AS $$
DECLARE
    current_quantized vector(1024);
    current_repo TEXT;
    current_org TEXT;
BEGIN
    current_quantized := query_embedding;

    SELECT
        payload->'repository'->>'name'::text,
        payload->'repository'->'owner'->>'login'::text
    INTO current_repo, current_org
    FROM documents
    WHERE id = current_id
      AND doc_type = 'issue';

    RETURN QUERY
    SELECT id AS issue_id,
           ((0.8 * (1 - cosine_distance(current_quantized, embedding))) + 0.8 * (1 / (1 + l2_distance(current_quantized, embedding)))) as similarity
    FROM documents
    WHERE id <> current_id
        AND doc_type = 'issue'
        AND deleted_at IS NULL
        AND embedding IS NOT NULL
        AND COALESCE(payload->'repository'->>'name', '') = COALESCE(current_repo, '')
        AND COALESCE(payload->'repository'->'owner'->>'login', '') = COALESCE(current_org, '')
        AND ((0.8 * (1 - cosine_distance(current_quantized, embedding))) + 0.8 * (1 / (1 + l2_distance(current_quantized, embedding)))) > threshold
    ORDER BY similarity DESC
    LIMIT top_k;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION find_similar_comments(query_embedding vector(1024), threshold float8, top_k INT)
RETURNS TABLE(comment_id VARCHAR, similarity float8) AS $$
BEGIN
    RETURN QUERY
    SELECT id AS comment_id,
           ((0.8 * (1 - cosine_distance(query_embedding, embedding))) + 0.8 * (1 / (1 + l2_distance(query_embedding, embedding)))) as similarity
    FROM documents
    WHERE deleted_at IS NULL
        AND embedding IS NOT NULL
        AND doc_type IN ('issue_comment', 'review_comment')
        AND ((0.8 * (1 - cosine_distance(query_embedding, embedding))) + 0.8 * (1 / (1 + l2_distance(query_embedding, embedding)))) > threshold
    ORDER BY similarity DESC
    LIMIT top_k;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION find_similar_issues_annotate(current_id VARCHAR, query_embedding vector(1024), threshold float8, top_k INT)
RETURNS TABLE(issue_id VARCHAR, similarity float8) AS $$
DECLARE
    current_quantized vector(1024);
BEGIN
    current_quantized := query_embedding;

    RETURN QUERY
    SELECT id AS issue_id,
           ((0.7 * (1 - cosine_distance(current_quantized, embedding))) + 0.3 * (1 / (1 + l2_distance(current_quantized, embedding)))) as similarity
    FROM documents
    WHERE id <> current_id
        AND doc_type = 'issue'
        AND deleted_at IS NULL
        AND embedding IS NOT NULL
        AND ((0.7 * (1 - cosine_distance(current_quantized, embedding))) + 0.3 * (1 / (1 + l2_distance(current_quantized, embedding)))) > threshold
    ORDER BY similarity DESC
    LIMIT top_k;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION find_similar_comments_annotate(current_id VARCHAR, query_embedding vector(1024), threshold float8, top_k INT)
RETURNS TABLE(comment_id VARCHAR, similarity float8) AS $$
DECLARE
    current_quantized vector(1024);
BEGIN
    current_quantized := query_embedding;

    RETURN QUERY
    SELECT id AS comment_id,
           ((0.7 * (1 - cosine_distance(current_quantized, embedding))) + 0.3 * (1 / (1 + l2_distance(current_quantized, embedding)))) as similarity
    FROM documents
    WHERE id <> current_id
        AND doc_type IN ('issue_comment', 'review_comment')
        AND deleted_at IS NULL
        AND embedding IS NOT NULL
        AND ((0.7 * (1 - cosine_distance(current_quantized, embedding))) + 0.3 * (1 / (1 + l2_distance(current_quantized, embedding)))) > threshold
    ORDER BY similarity DESC
    LIMIT top_k;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION find_similar_issues_to_match(current_id VARCHAR, query_embedding vector(1024), threshold float8, top_k INT)
RETURNS TABLE(issue_id VARCHAR, similarity float8) AS $$
DECLARE
    current_quantized vector(1024);
BEGIN
    current_quantized := query_embedding;

    RETURN QUERY
    SELECT id AS issue_id,
           ((0.8 * (1 - cosine_distance(current_quantized, embedding))) + 0.2 * (1 / (1 + l2_distance(current_quantized, embedding)))) as similarity
    FROM documents
    WHERE id <> current_id
        AND doc_type = 'issue'
        AND deleted_at IS NULL
        AND embedding IS NOT NULL
        AND ((0.8 * (1 - cosine_distance(current_quantized, embedding))) + 0.2 * (1 / (1 + l2_distance(current_quantized, embedding)))) > threshold
    ORDER BY similarity DESC
    LIMIT top_k;
END;
$$ LANGUAGE plpgsql;

DROP TABLE IF EXISTS issue_comments CASCADE;
DROP TABLE IF EXISTS issues CASCADE;
