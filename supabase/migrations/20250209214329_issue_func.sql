DROP FUNCTION IF EXISTS find_similar_issues;
DROP FUNCTION IF EXISTS find_similar_comments;

CREATE OR REPLACE FUNCTION find_similar_issues(current_id VARCHAR, query_embedding vector(1024), threshold float8, top_k INT)
RETURNS TABLE(issue_id VARCHAR, issue_plaintext TEXT, similarity float8) AS $$
DECLARE
    current_quantized vector(1024);
    current_repo TEXT;
    current_org TEXT;
BEGIN
    -- Ensure the query_embedding is in the correct format
    current_quantized := query_embedding;

    -- Extract the current issue's repo and org from the payload
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
        AND COALESCE(payload->'repository'->>'name', '') = COALESCE(current_repo, '') -- To handle Private Issues
        AND COALESCE(payload->'repository'->'owner'->>'login', '') = COALESCE(current_org, '') -- To handle Private Issues
        AND ((0.8 * (1 - cosine_distance(current_quantized, embedding))) + 0.8 * (1 / (1 + l2_distance(current_quantized, embedding)))) > threshold
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
    FROM comments
    WHERE ((0.8 * (1 - cosine_distance(query_embedding, embedding))) + 0.8 * (1 / (1 + l2_distance(query_embedding, embedding)))) > threshold
    ORDER BY similarity DESC
    LIMIT top_k;
END;