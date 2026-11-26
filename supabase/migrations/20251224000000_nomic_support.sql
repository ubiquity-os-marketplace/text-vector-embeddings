-- Add Nomic embedding column
ALTER TABLE documents ADD COLUMN IF NOT EXISTS embedding_nomic vector(768);

-- Create index for Nomic embeddings
CREATE INDEX IF NOT EXISTS documents_embedding_nomic_ivfflat
  ON public.documents USING ivfflat (embedding_nomic vector_cosine_ops)
  WITH (lists='10');

-- Nomic Specific RPC Functions
CREATE OR REPLACE FUNCTION find_similar_issues_nomic(current_id VARCHAR, query_embedding vector(768), threshold float8, top_k INT)
RETURNS TABLE(issue_id VARCHAR, similarity float8) AS $$
DECLARE
    current_repo TEXT;
    current_org TEXT;
BEGIN
    SELECT
        payload->'repository'->>'name'::text,
        payload->'repository'->'owner'->>'login'::text
    INTO current_repo, current_org
    FROM documents
    WHERE id = current_id
      AND doc_type = 'issue';

    RETURN QUERY
    SELECT sub.issue_id,
           sub.similarity
    FROM (
        SELECT id AS issue_id,
               ((0.8 * (1 - cosine_distance(query_embedding, embedding_nomic))) + 0.8 * (1 / (1 + l2_distance(query_embedding, embedding_nomic)))) as similarity
        FROM documents
        WHERE id <> current_id
            AND doc_type = 'issue'
            AND deleted_at IS NULL
            AND embedding_nomic IS NOT NULL
            AND COALESCE(payload->'repository'->>'name', '') = COALESCE(current_repo, '')
            AND COALESCE(payload->'repository'->'owner'->>'login', '') = COALESCE(current_org, '')
    ) sub
    WHERE sub.similarity > threshold
    ORDER BY sub.similarity DESC
    LIMIT top_k;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION find_similar_comments_nomic(query_embedding vector(768), threshold float8, top_k INT)
RETURNS TABLE(comment_id VARCHAR, similarity float8) AS $$
BEGIN
    RETURN QUERY
    SELECT sub.comment_id,
           sub.similarity
    FROM (
        SELECT id AS comment_id,
               ((0.8 * (1 - cosine_distance(query_embedding, embedding_nomic))) + 0.8 * (1 / (1 + l2_distance(query_embedding, embedding_nomic)))) as similarity
        FROM documents
        WHERE deleted_at IS NULL
            AND embedding_nomic IS NOT NULL
            AND doc_type IN ('issue_comment', 'review_comment', 'pull_request_review')
    ) sub
    WHERE sub.similarity > threshold
    ORDER BY sub.similarity DESC
    LIMIT top_k;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION find_similar_issues_annotate_nomic(current_id VARCHAR, query_embedding vector(768), threshold float8, top_k INT)
RETURNS TABLE(issue_id VARCHAR, similarity float8) AS $$
BEGIN
    RETURN QUERY
    SELECT sub.issue_id,
           sub.similarity
    FROM (
        SELECT id AS issue_id,
               ((0.7 * (1 - cosine_distance(query_embedding, embedding_nomic))) + 0.3 * (1 / (1 + l2_distance(query_embedding, embedding_nomic)))) as similarity
        FROM documents
        WHERE id <> current_id
            AND doc_type = 'issue'
            AND deleted_at IS NULL
            AND embedding_nomic IS NOT NULL
    ) sub
    WHERE sub.similarity > threshold
    ORDER BY sub.similarity DESC
    LIMIT top_k;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION find_similar_comments_annotate_nomic(current_id VARCHAR, query_embedding vector(768), threshold float8, top_k INT)
RETURNS TABLE(comment_id VARCHAR, similarity float8) AS $$
BEGIN
    RETURN QUERY
    SELECT sub.comment_id,
           sub.similarity
    FROM (
        SELECT id AS comment_id,
               ((0.7 * (1 - cosine_distance(query_embedding, embedding_nomic))) + 0.3 * (1 / (1 + l2_distance(query_embedding, embedding_nomic)))) as similarity
        FROM documents
        WHERE id <> current_id
            AND doc_type IN ('issue_comment', 'review_comment', 'pull_request_review')
            AND deleted_at IS NULL
            AND embedding_nomic IS NOT NULL
    ) sub
    WHERE sub.similarity > threshold
    ORDER BY sub.similarity DESC
    LIMIT top_k;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION find_similar_issues_to_match_nomic(current_id VARCHAR, query_embedding vector(768), threshold float8, top_k INT)
RETURNS TABLE(issue_id VARCHAR, similarity float8) AS $$
BEGIN
    RETURN QUERY
    SELECT sub.issue_id,
           sub.similarity
    FROM (
        SELECT id AS issue_id,
               ((0.8 * (1 - cosine_distance(query_embedding, embedding_nomic))) + 0.2 * (1 / (1 + l2_distance(query_embedding, embedding_nomic)))) as similarity
        FROM documents
        WHERE id <> current_id
            AND doc_type = 'issue'
            AND deleted_at IS NULL
            AND embedding_nomic IS NOT NULL
    ) sub
    WHERE sub.similarity > threshold
    ORDER BY sub.similarity DESC
    LIMIT top_k;
END;
$$ LANGUAGE plpgsql;


