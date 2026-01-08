DROP VIEW IF EXISTS memory_messages;

CREATE VIEW memory_messages AS
SELECT
    'issue'::text AS source_type,
    issues.id AS source_id,
    (issues.payload -> 'repository'::text) ->> 'name'::text AS repo,
    ((issues.payload -> 'repository'::text) -> 'owner'::text) ->> 'login'::text AS owner,
    (issues.payload -> 'issue'::text) ->> 'html_url'::text AS source_url,
    (issues.payload -> 'issue'::text) ->> 'number'::text AS issue_number,
    issues.author_id,
    issues.markdown,
    issues.embedding,
    issues.created_at,
    issues.modified_at
FROM issues
WHERE issues.deleted_at IS NULL
  AND issues.embedding_status = 'ready'::text
  AND issues.embedding IS NOT NULL
UNION ALL
SELECT
    'issue_comment'::text AS source_type,
    issue_comments.id AS source_id,
    (issue_comments.payload -> 'repository'::text) ->> 'name'::text AS repo,
    ((issue_comments.payload -> 'repository'::text) -> 'owner'::text) ->> 'login'::text AS owner,
    (issue_comments.payload -> 'comment'::text) ->> 'html_url'::text AS source_url,
    COALESCE(
      (issue_comments.payload -> 'issue'::text) ->> 'number'::text,
      (issue_comments.payload -> 'pull_request'::text) ->> 'number'::text
    ) AS issue_number,
    issue_comments.author_id,
    issue_comments.markdown,
    issue_comments.embedding,
    issue_comments.created_at,
    issue_comments.modified_at
FROM issue_comments
WHERE issue_comments.deleted_at IS NULL
  AND issue_comments.embedding_status = 'ready'::text
  AND issue_comments.embedding IS NOT NULL;

ALTER TABLE issues
  DROP COLUMN IF EXISTS plaintext;

ALTER TABLE issue_comments
  DROP COLUMN IF EXISTS plaintext;

DROP FUNCTION IF EXISTS find_similar_issues(VARCHAR, vector(1024), float8, INT);
DROP FUNCTION IF EXISTS find_similar_comments(vector(1024), float8, INT);
DROP FUNCTION IF EXISTS find_similar_issues_annotate(VARCHAR, vector(1024), float8, INT);
DROP FUNCTION IF EXISTS find_similar_comments_annotate(VARCHAR, vector(1024), float8, INT);
DROP FUNCTION IF EXISTS find_similar_issues_to_match(VARCHAR, vector(1024), float8, INT);

CREATE OR REPLACE FUNCTION find_similar_issues(current_id VARCHAR, query_embedding vector(1024), threshold float8, top_k INT)
RETURNS TABLE(issue_id VARCHAR, similarity float8) AS $$
DECLARE
    current_repo TEXT;
    current_org TEXT;
BEGIN
    SELECT
        payload->'repository'->>'name'::text,
        payload->'repository'->'owner'->>'login'::text
    INTO current_repo, current_org
    FROM issues
    WHERE id = current_id;

    RETURN QUERY
    SELECT sub.issue_id,
           sub.similarity
    FROM (
        SELECT id AS issue_id,
               ((0.8 * (1 - cosine_distance(query_embedding, embedding))) + 0.8 * (1 / (1 + l2_distance(query_embedding, embedding)))) as similarity
        FROM issues
        WHERE id <> current_id
            AND deleted_at IS NULL
            AND embedding IS NOT NULL
            AND COALESCE(payload->'repository'->>'name', '') = COALESCE(current_repo, '')
            AND COALESCE(payload->'repository'->'owner'->>'login', '') = COALESCE(current_org, '')
    ) sub
    WHERE sub.similarity > threshold
    ORDER BY sub.similarity DESC
    LIMIT top_k;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION find_similar_comments(query_embedding vector(1024), threshold float8, top_k INT)
RETURNS TABLE(comment_id VARCHAR, similarity float8) AS $$
BEGIN
    RETURN QUERY
    SELECT sub.comment_id,
           sub.similarity
    FROM (
        SELECT id AS comment_id,
               ((0.8 * (1 - cosine_distance(query_embedding, embedding))) + 0.8 * (1 / (1 + l2_distance(query_embedding, embedding)))) as similarity
        FROM issue_comments
        WHERE deleted_at IS NULL
            AND embedding IS NOT NULL
    ) sub
    WHERE sub.similarity > threshold
    ORDER BY sub.similarity DESC
    LIMIT top_k;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION find_similar_issues_annotate(current_id VARCHAR, query_embedding vector(1024), threshold float8, top_k INT)
RETURNS TABLE(issue_id VARCHAR, similarity float8) AS $$
BEGIN
    RETURN QUERY
    SELECT sub.issue_id,
           sub.similarity
    FROM (
        SELECT id AS issue_id,
               ((0.7 * (1 - cosine_distance(query_embedding, embedding))) + 0.3 * (1 / (1 + l2_distance(query_embedding, embedding)))) as similarity
        FROM issues
        WHERE id <> current_id
            AND deleted_at IS NULL
            AND embedding IS NOT NULL
    ) sub
    WHERE sub.similarity > threshold
    ORDER BY sub.similarity DESC
    LIMIT top_k;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION find_similar_comments_annotate(current_id VARCHAR, query_embedding vector(1024), threshold float8, top_k INT)
RETURNS TABLE(comment_id VARCHAR, similarity float8) AS $$
BEGIN
    RETURN QUERY
    SELECT sub.comment_id,
           sub.similarity
    FROM (
        SELECT id AS comment_id,
               ((0.7 * (1 - cosine_distance(query_embedding, embedding))) + 0.3 * (1 / (1 + l2_distance(query_embedding, embedding)))) as similarity
        FROM issue_comments
        WHERE id <> current_id
            AND deleted_at IS NULL
            AND embedding IS NOT NULL
    ) sub
    WHERE sub.similarity > threshold
    ORDER BY sub.similarity DESC
    LIMIT top_k;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION find_similar_issues_to_match(current_id VARCHAR, query_embedding vector(1024), threshold float8, top_k INT)
RETURNS TABLE(issue_id VARCHAR, similarity float8) AS $$
BEGIN
    RETURN QUERY
    SELECT sub.issue_id,
           sub.similarity
    FROM (
        SELECT id AS issue_id,
               ((0.8 * (1 - cosine_distance(query_embedding, embedding))) + 0.2 * (1 / (1 + l2_distance(query_embedding, embedding)))) as similarity
        FROM issues
        WHERE id <> current_id
            AND deleted_at IS NULL
            AND embedding IS NOT NULL
    ) sub
    WHERE sub.similarity > threshold
    ORDER BY sub.similarity DESC
    LIMIT top_k;
END;
$$ LANGUAGE plpgsql;
