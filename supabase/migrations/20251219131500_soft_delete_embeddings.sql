CREATE EXTENSION IF NOT EXISTS vector;

SET search_path = public, extensions;

ALTER TABLE issues
ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

ALTER TABLE issue_comments
ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

ALTER TABLE issues
ADD COLUMN IF NOT EXISTS embedding_status text NOT NULL DEFAULT 'ready';

ALTER TABLE issue_comments
ADD COLUMN IF NOT EXISTS embedding_status text NOT NULL DEFAULT 'ready';

ALTER TABLE issues
ADD COLUMN IF NOT EXISTS embedding_model text;

ALTER TABLE issue_comments
ADD COLUMN IF NOT EXISTS embedding_model text;

ALTER TABLE issues
ADD COLUMN IF NOT EXISTS embedding_dim int;

ALTER TABLE issue_comments
ADD COLUMN IF NOT EXISTS embedding_dim int;

ALTER TABLE issues
ALTER COLUMN embedding DROP NOT NULL;

ALTER TABLE issue_comments
ALTER COLUMN embedding DROP NOT NULL;

DROP FUNCTION IF EXISTS find_similar_issues;
DROP FUNCTION IF EXISTS find_similar_issues_to_match;
DROP FUNCTION IF EXISTS find_similar_issues_annotate;
DROP FUNCTION IF EXISTS find_similar_comments_annotate;
DROP FUNCTION IF EXISTS find_similar_comments;

CREATE OR REPLACE FUNCTION find_similar_issues(current_id VARCHAR, query_embedding vector(1024), threshold float8, top_k INT)
RETURNS TABLE(issue_id VARCHAR, issue_plaintext TEXT, similarity float8) AS $$
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
    FROM issues
    WHERE id = current_id;

    RETURN QUERY
    SELECT id AS issue_id,
           plaintext AS issue_plaintext,
           ((0.8 * (1 - cosine_distance(current_quantized, embedding))) + 0.8 * (1 / (1 + l2_distance(current_quantized, embedding)))) as similarity
    FROM issues
    WHERE id <> current_id
        AND deleted_at IS NULL
        AND embedding IS NOT NULL
        AND embedding_status = 'ready'
        AND COALESCE(payload->'repository'->>'name', '') = COALESCE(current_repo, '')
        AND COALESCE(payload->'repository'->'owner'->>'login', '') = COALESCE(current_org, '')
        AND ((0.8 * (1 - cosine_distance(current_quantized, embedding))) + 0.8 * (1 / (1 + l2_distance(current_quantized, embedding)))) > threshold
    ORDER BY similarity DESC
    LIMIT top_k;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION find_similar_issues_to_match(current_id VARCHAR, query_embedding vector(1024), threshold float8, top_k INT)
RETURNS TABLE(issue_id VARCHAR, issue_plaintext TEXT, similarity float8) AS $$
DECLARE
    current_quantized vector(1024);
BEGIN
    current_quantized := query_embedding;

    RETURN QUERY
    SELECT id AS issue_id,
           plaintext AS issue_plaintext,
           ((0.8 * (1 - cosine_distance(current_quantized, embedding))) + 0.2 * (1 / (1 + l2_distance(current_quantized, embedding)))) as similarity
    FROM issues
    WHERE id <> current_id
        AND deleted_at IS NULL
        AND embedding IS NOT NULL
        AND embedding_status = 'ready'
        AND ((0.8 * (1 - cosine_distance(current_quantized, embedding))) + 0.2 * (1 / (1 + l2_distance(current_quantized, embedding)))) > threshold
    ORDER BY similarity DESC
    LIMIT top_k;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION find_similar_issues_annotate(current_id VARCHAR, query_embedding vector(1024), threshold float8, top_k INT)
RETURNS TABLE(issue_id VARCHAR, issue_plaintext TEXT, similarity float8) AS $$
DECLARE
    current_quantized vector(1024);
BEGIN
    current_quantized := query_embedding;

    RETURN QUERY
    SELECT id AS issue_id,
           plaintext AS issue_plaintext,
           ((0.7 * (1 - cosine_distance(current_quantized, embedding))) + 0.3 * (1 / (1 + l2_distance(current_quantized, embedding)))) as similarity
    FROM issues
    WHERE id <> current_id
        AND deleted_at IS NULL
        AND embedding IS NOT NULL
        AND embedding_status = 'ready'
        AND ((0.7 * (1 - cosine_distance(current_quantized, embedding))) + 0.3 * (1 / (1 + l2_distance(current_quantized, embedding)))) > threshold
    ORDER BY similarity DESC
    LIMIT top_k;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION find_similar_comments_annotate(current_id VARCHAR, query_embedding vector(1024), threshold float8, top_k INT)
RETURNS TABLE(comment_id VARCHAR, comment_plaintext TEXT, similarity float8) AS $$
DECLARE
    current_quantized vector(1024);
BEGIN
    current_quantized := query_embedding;

    RETURN QUERY
    SELECT id AS comment_id,
           plaintext AS comment_plaintext,
           ((0.7 * (1 - cosine_distance(current_quantized, embedding))) + 0.3 * (1 / (1 + l2_distance(current_quantized, embedding)))) as similarity
    FROM issue_comments
    WHERE id <> current_id
        AND deleted_at IS NULL
        AND embedding IS NOT NULL
        AND embedding_status = 'ready'
        AND ((0.7 * (1 - cosine_distance(current_quantized, embedding))) + 0.3 * (1 / (1 + l2_distance(current_quantized, embedding)))) > threshold
    ORDER BY similarity DESC
    LIMIT top_k;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION find_similar_comments(query_embedding vector(1024), threshold float8, top_k INT)
RETURNS TABLE(comment_id VARCHAR, comment_plaintext TEXT, similarity float8) AS $$
BEGIN
    RETURN QUERY
    SELECT id AS comment_id,
           plaintext AS comment_plaintext,
           ((0.8 * (1 - cosine_distance(query_embedding, embedding))) + 0.8 * (1 / (1 + l2_distance(query_embedding, embedding)))) as similarity
    FROM issue_comments
    WHERE deleted_at IS NULL
        AND embedding IS NOT NULL
        AND embedding_status = 'ready'
        AND ((0.8 * (1 - cosine_distance(query_embedding, embedding))) + 0.8 * (1 / (1 + l2_distance(query_embedding, embedding)))) > threshold
    ORDER BY similarity DESC
    LIMIT top_k;
END;
$$ LANGUAGE plpgsql;
